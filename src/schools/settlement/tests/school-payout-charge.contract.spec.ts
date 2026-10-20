import {
  bootSchoolNuvion,
  type Person,
  type SchoolNuvion,
  type SeededClass,
} from '../../../../test/schools/school-nuvion-harness';
import { LedgerService } from '../../../money/ledger/ledger.service';
import type { NuvionPayoutReading } from '../../../nuvion/areas/payouts';
import { NuvionBankOutflowRecorder } from '../../../nuvion/handlers/outflows-bank';
import { lagosToday } from '../../enrolment/school-enrolment-rules';
import { SchoolPayeeService } from '../school-payee.service';
import { SchoolSettlementService } from '../school-settlement.service';

/**
 * FIX-74 (G-SWEEP-MONEY-1, SCHOOLS-11 L1): a school payout whose quoted bank
 * charge differs from the provider's real one AND whose answer was lost.
 * Quote 2,000, the provider charges 2,500. Nuvion's own webhook completes the
 * ledger row at the quoted total first; the settlement's completion then
 * states 2,500. The row must end `completed` at the provider's total, with
 * the ledger equal to the stand-in and one audit note, instead of going back
 * to `pending` and staying 500 kobo below what the provider debited.
 *
 * On the Nuvion stand-in only (`NuvionSeamStandIn` at the wallet seam; the
 * webhook is Nuvion's own outflow recorder fed with the stand-in's transfer).
 * Nothing here reaches a provider.
 */

jest.setTimeout(180_000);

const PRICE = 15_000_000;
const SCHOOL_SHARE = 12_750_000n;
const QUOTED = 2_000n;
const REAL = 2_500n;
const HOLDER = 'GREENFIELD TECH ACADEMY LTD';
const LONG_REST = 61 * 60_000;
const AUDIT = "Restated to Nuvion's own record of";

describe('A school payout whose real bank charge differs from the quote (FIX-74)', () => {
  let h: SchoolNuvion;
  let settlements: SchoolSettlementService;
  let payees: SchoolPayeeService;
  let ledger: LedgerService;
  const schoolIds: string[] = [];
  let acctSeq = 0;
  let clock = Date.now();
  const later = (ms = 10 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  beforeAll(async () => {
    h = await bootSchoolNuvion('fix74', { NUVION_FEE_BANK_PAYOUT: '0:2000' });
    settlements = h.app.get(SchoolSettlementService);
    payees = h.app.get(SchoolPayeeService);
    ledger = h.app.get(LedgerService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(() => {
    h.nuvion.bankMode = 'pending';
    h.nuvion.mode = 'pending';
    h.nuvion.bankFeeKobo = () => REAL;
    h.nuvion.feeKobo = () => 0n;
    jest.restoreAllMocks();
  });

  async function classAt(startDate: string): Promise<SeededClass> {
    const c = await h.seed({
      priceKobo: PRICE,
      intakes: [{ capacity: 10, startDate }],
    });
    schoolIds.push(c.schoolId);
    acctSeq += 1;
    const account = `01${String(Date.now()).slice(-6)}${String(acctSeq).padStart(2, '0')}`;
    h.nuvion.bankDirectory.set(`058:${account}`, HOLDER);
    await payees.set(
      c.schoolId,
      { bankCode: '058', accountNumber: account },
      null,
    );
    return c;
  }
  const student = (): Promise<Person> => h.person(20_000_000);
  const settlementOf = (enrolmentId: string) =>
    h.prisma.schoolSettlement.findUniqueOrThrow({ where: { enrolmentId } });
  const rowOf = (ref: string) =>
    h.prisma.fintavaLedgerEntry.findFirstOrThrow({
      where: { customerReference: ref },
    });
  const transferOf = (ref: string) =>
    h.nuvion.bankSends().find((t) => t.request.unique_reference === ref)!;

  /** A payout in flight whose send's answer was lost: Nuvion holds it, the Hub never heard. */
  async function lostAnswer(): Promise<{
    enrolmentId: string;
    settlementId: string;
    ref: string;
  }> {
    const c = await classAt(lagosToday(new Date()));
    const enrolmentId = await h.enrolAndPay(await student(), c.intakeIds[0]);
    h.nuvion.bankMode = 'lost_answer';
    await settlements.run(later());
    const s = await settlementOf(enrolmentId);
    expect(s.status).toBe('sent');
    const ref = `wawu-bank-sch-${s.id}`;
    const row = await rowOf(ref);
    expect(row.status).toBe('pending');
    expect(BigInt(row.totalKobo)).toBe(SCHOOL_SHARE + QUOTED);
    h.nuvion.bankMode = 'pending';
    return { enrolmentId, settlementId: s.id, ref };
  }

  /** Nuvion's `outflows.completed` for the send, through Nuvion's own recorder (the webhook's write). */
  async function webhookCompleted(
    settlementId: string,
    ref: string,
    eventId = 'evt-fix74-1',
  ): Promise<void> {
    const t = transferOf(ref);
    const s = await h.prisma.schoolSettlement.findUniqueOrThrow({
      where: { id: settlementId },
    });
    const hold = await h.prisma.walletHold.findUniqueOrThrow({
      where: { id: s.holdId },
      select: { merchantAccountNumber: true },
    });
    const reading: NuvionPayoutReading = {
      id: t.id,
      entityId: null,
      accountId: t.fromAccountId,
      amountKobo: Number(t.amountKobo),
      feeKobo: Number(t.feeKobo),
      currency: 'NGN',
      status: 'successful',
      type: 'outflow',
      paymentType: 'bank-transfer',
      uniqueReference: ref,
      counterpartyId: null,
      narration: t.request.narration,
      createdAt: new Date(t.created),
      paymentDetailId: null,
      feeStated: true,
      statusReason: null,
      sourcePaymentId: null,
    };
    // recordOutflow reads nothing from the area: it is the recorder's write.
    const recorder = new NuvionBankOutflowRecorder(
      h.prisma,
      undefined as never,
      ledger,
      { operationalAccountId: h.nuvion.operational.accountId },
    );
    await recorder.recordOutflow(
      reading,
      { kind: 'merchant', accountNumber: hold.merchantAccountNumber },
      'completed',
      eventId,
      {
        bankName: s.bankName,
        bankCode: s.bankCode,
        accountNumber: s.bankAccountNumber,
        accountName: s.bankAccountName,
      },
    );
  }

  /** The ledger's completed payout equals what the stand-in sent, to the kobo. */
  async function ledgerEqualsStandin(ref: string): Promise<void> {
    const rows = await h.prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: ref, direction: 'out' },
    });
    expect(rows).toHaveLength(1);
    const t = transferOf(ref);
    expect(t.status).toBe('successful');
    expect(rows[0].status).toBe('completed');
    expect(BigInt(rows[0].totalKobo)).toBe(t.amountKobo + t.feeKobo);
    expect(BigInt(rows[0].feeKobo)).toBe(t.feeKobo);
  }

  const auditNotes = (discrepancy: string | null) =>
    (discrepancy ?? '').split(AUDIT).length - 1;
  const disagreementLogged = () =>
    h.logger.lines.filter((l) => l.includes('a sighting disagreed with row'));

  it('webhook first: the row ends completed at the provider total, the ledger equals the stand-in, one audit note', async () => {
    const { enrolmentId, settlementId, ref } = await lostAnswer();
    h.nuvion.settle(ref, 'successful');
    await webhookCompleted(settlementId, ref);
    // The webhook completed the row at the quoted total and noted the other charge.
    const afterWebhook = await rowOf(ref);
    expect(afterWebhook.status).toBe('completed');
    expect(BigInt(afterWebhook.totalKobo)).toBe(SCHOOL_SHARE + QUOTED);
    h.logger.lines.length = 0;

    await settlements.run(later(LONG_REST));
    expect((await settlementOf(enrolmentId)).status).toBe('paid');

    const row = await rowOf(ref);
    expect(row.status).toBe('completed');
    expect(BigInt(row.feeKobo)).toBe(REAL);
    expect(BigInt(row.providerFeeKobo ?? 0)).toBe(REAL);
    expect(BigInt(row.totalKobo)).toBe(SCHOOL_SHARE + REAL);
    expect(row.completedAt).not.toBeNull();
    expect(auditNotes(row.discrepancy)).toBe(1);
    // The audit note says the old and the new totals, the reference, and when.
    const note = row.discrepancy!.slice(row.discrepancy!.indexOf(AUDIT));
    expect(note).toContain(ref);
    expect(note).toContain(String(SCHOOL_SHARE + QUOTED));
    expect(note).toContain(String(SCHOOL_SHARE + REAL));
    expect(note).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(disagreementLogged()).toEqual([]);
    await ledgerEqualsStandin(ref);
  });

  it('webhook first: further sweeps and a replayed webhook change nothing more', async () => {
    const { enrolmentId, settlementId, ref } = await lostAnswer();
    h.nuvion.settle(ref, 'successful');
    await webhookCompleted(settlementId, ref);
    await settlements.run(later(LONG_REST));
    expect((await settlementOf(enrolmentId)).status).toBe('paid');
    const once = await rowOf(ref);
    expect(once.status).toBe('completed');
    expect(auditNotes(once.discrepancy)).toBe(1);

    await webhookCompleted(settlementId, ref);
    await webhookCompleted(settlementId, ref, 'evt-fix74-2');
    await Promise.all(
      Array.from({ length: 3 }, () => settlements.run(later(LONG_REST))),
    );
    const again = await rowOf(ref);
    for (const k of [
      'status',
      'feeKobo',
      'providerFeeKobo',
      'totalKobo',
      'discrepancy',
      'completedAt',
    ] as const) {
      expect(again[k]).toEqual(once[k]);
    }
    expect(auditNotes(again.discrepancy)).toBe(1);
    await ledgerEqualsStandin(ref);
  });

  it('completion first: the same end state, with the webhook after it', async () => {
    const { enrolmentId, settlementId, ref } = await lostAnswer();
    h.nuvion.settle(ref, 'successful');
    await settlements.run(later(LONG_REST));
    expect((await settlementOf(enrolmentId)).status).toBe('paid');
    let row = await rowOf(ref);
    expect(row.status).toBe('completed');
    expect(BigInt(row.totalKobo)).toBe(SCHOOL_SHARE + REAL);
    expect(row.discrepancy).toBeNull();

    h.logger.lines.length = 0;
    await webhookCompleted(settlementId, ref);
    row = await rowOf(ref);
    expect(row.status).toBe('completed');
    expect(BigInt(row.feeKobo)).toBe(REAL);
    expect(BigInt(row.totalKobo)).toBe(SCHOOL_SHARE + REAL);
    // The pending row took the provider's charge while it was pending: no
    // disagreement, so no note and no audit note.
    expect(row.discrepancy).toBeNull();
    expect(disagreementLogged()).toEqual([]);
    await ledgerEqualsStandin(ref);
  });

  it('a provider record of another reference never restates the row: it flags, as before', async () => {
    const { enrolmentId, settlementId, ref } = await lostAnswer();
    h.nuvion.settle(ref, 'successful');
    await webhookCompleted(settlementId, ref);
    const real = h.nuvion.reconcileSend.bind(h.nuvion);
    jest
      .spyOn(h.nuvion, 'reconcileSend')
      .mockImplementation(async (reference, holder, since) => {
        const answer = await real(reference, holder, since);
        if (answer.state !== 'found') return answer;
        return {
          ...answer,
          transaction: {
            ...answer.transaction,
            ourReference: `${answer.transaction.ourReference}-other`,
          },
        };
      });
    h.logger.lines.length = 0;
    await settlements.run(later(LONG_REST));
    const row = await rowOf(ref);
    expect(auditNotes(row.discrepancy)).toBe(0);
    expect(BigInt(row.feeKobo)).toBe(QUOTED);
    // The disagreement is flagged, as it is today.
    expect(row.status).toBe('pending');
    expect(row.discrepancy).toContain('completed put back to pending');
    expect(disagreementLogged()).toHaveLength(1);
    expect((await settlementOf(enrolmentId)).status).toBe('paid');
  });

  it('a pending row behaves as before: it takes the provider charge and completes with no note', async () => {
    const c = await classAt(lagosToday(new Date()));
    const enrolmentId = await h.enrolAndPay(await student(), c.intakeIds[0]);
    await settlements.run(later());
    const s = await settlementOf(enrolmentId);
    const ref = `wawu-bank-sch-${s.id}`;
    let row = await rowOf(ref);
    // The accepted answer states the charge: the pending row already says it.
    expect(row.status).toBe('pending');
    expect(BigInt(row.totalKobo)).toBe(SCHOOL_SHARE + REAL);
    h.nuvion.settle(ref, 'successful');
    await settlements.run(later(LONG_REST));
    expect((await settlementOf(enrolmentId)).status).toBe('paid');
    row = await rowOf(ref);
    expect(row.status).toBe('completed');
    expect(BigInt(row.totalKobo)).toBe(SCHOOL_SHARE + REAL);
    expect(row.discrepancy).toBeNull();
    await ledgerEqualsStandin(ref);
  });
});
