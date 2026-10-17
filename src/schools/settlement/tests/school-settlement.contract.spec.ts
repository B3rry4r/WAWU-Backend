import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bootSchoolNuvion,
  body,
  type Person,
  type SchoolNuvion,
  type SeededClass,
} from '../../../../test/schools/school-nuvion-harness';
import { WalletHoldService } from '../../../money/holds/wallet-hold.service';
import {
  lagosToday,
  splitCourseFee,
} from '../../enrolment/school-enrolment-rules';
import { SchoolPayeeService } from '../school-payee.service';
import { SchoolSettlementService } from '../school-settlement.service';
import type {
  CancelIntakeView,
  SchoolPayeeView,
  SchoolSettlementPage,
  SchoolSettlementView,
} from '../school-settlement-view.type';

/**
 * Pay schools their share of course fees (task SCHOOLS-11, R-12, R-10, R-31)
 * on Nuvion stood in at the wallet seam (`NuvionSeamStandIn`: book transfers
 * and bank sends from WAWU's operational account, a bank send accepted as
 * `pending` and finished by `settle`). Nothing here reaches a provider.
 *
 * The attacks: a payout run twice in parallel pays once; a failed payout is
 * retried once and never doubles; a refund of an enrolment after the payout;
 * the school's share and WAWU's 15 add up to the fee to the kobo; and after
 * each the ledger equals the stand-in.
 */

jest.setTimeout(180_000);

const PRICE = 15_000_000; // 150,000 naira
const SCHOOL_SHARE = 12_750_000;
const WAWU_SHARE = 2_250_000;
const BANK_FEE = 2_500n; // the stand-in's bank charge, WAWU's (R-31)
const BOOK_FEE = 1_500n; // the stand-in's book charge on a refund, WAWU's
const HOLDER = 'GREENFIELD TECH ACADEMY LTD';

describe('Pay schools their share of course fees (SCHOOLS-11) on Nuvion stood in', () => {
  let h: SchoolNuvion;
  let settlements: SchoolSettlementService;
  let payees: SchoolPayeeService;
  let holds: WalletHoldService;
  const schoolIds: string[] = [];
  let acctSeq = 0;
  let clock = Date.now();
  const later = (ms = 10 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };
  const today = () => lagosToday(new Date());
  const inDays = (n: number) =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    h = await bootSchoolNuvion('s11');
    settlements = h.app.get(SchoolSettlementService);
    payees = h.app.get(SchoolPayeeService);
    holds = h.app.get(WalletHoldService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(() => {
    h.nuvion.bankMode = 'pending';
    h.nuvion.mode = 'pending';
    h.nuvion.bankFeeKobo = () => BANK_FEE;
    h.nuvion.feeKobo = () => 0n;
  });

  /** A school with one class starting on `startDate` and a bank account the bank confirms. */
  async function classAt(
    startDate: string,
    opts: { priceKobo?: number; payee?: boolean; capacity?: number } = {},
  ): Promise<SeededClass & { account: string }> {
    const c = await h.seed({
      priceKobo: opts.priceKobo ?? PRICE,
      intakes: [{ capacity: opts.capacity ?? 10, startDate }],
    });
    schoolIds.push(c.schoolId);
    acctSeq += 1;
    const account = `01${String(Date.now()).slice(-6)}${String(acctSeq).padStart(2, '0')}`;
    h.nuvion.bankDirectory.set(`058:${account}`, HOLDER);
    if (opts.payee !== false) {
      await payees.set(
        c.schoolId,
        { bankCode: '058', accountNumber: account },
        null,
      );
    }
    return { ...c, account };
  }

  const student = (kobo = 20_000_000) => h.person(kobo);
  const settlementOf = (enrolmentId: string) =>
    h.prisma.schoolSettlement.findUniqueOrThrow({ where: { enrolmentId } });
  const holdOf = (id: string) =>
    h.prisma.walletHold.findUniqueOrThrow({ where: { id } });
  const enrolmentOf = (id: string) =>
    h.prisma.schoolEnrolment.findUniqueOrThrow({ where: { id } });
  const sendsOf = (settlementId: string) =>
    h.nuvion
      .bankSends()
      .filter((t) =>
        t.request.unique_reference.startsWith(`wawu-bank-sch-${settlementId}`),
      );
  const balance = (p: Person) =>
    h.nuvion.accounts.get(p.account.accountId)!.availableKobo;
  /** Finishes every bank send Nuvion holds for these settlements. */
  function finishSends(ids: string[], status: 'successful' | 'failed'): void {
    for (const id of ids) {
      for (const t of sendsOf(id)) {
        if (t.status === 'pending' || t.status === 'processing') {
          h.nuvion.settle(t.request.unique_reference, status);
        }
      }
    }
  }
  async function paidEnrolment(c: SeededClass, p: Person): Promise<string> {
    return h.enrolAndPay(p, c.intakeIds[0]);
  }
  /** Nuvion answers a refund's book transfer at once. */
  function refundsSettleAtOnce() {
    h.nuvion.mode = 'successful';
    h.nuvion.feeKobo = () => BOOK_FEE;
  }

  /** After each attack: the ledger's completed payouts equal what the stand-in sent. */
  async function ledgerEqualsStandin(): Promise<void> {
    const rows = await h.prisma.schoolSettlement.findMany({
      where: { schoolId: { in: schoolIds } },
      select: { id: true },
    });
    const refs = rows.flatMap((r) => [
      `wawu-bank-sch-${r.id}`,
      `wawu-bank-sch-${r.id}-2`,
    ]);
    const ledger = await h.prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: { in: refs },
        direction: 'out',
        status: 'completed',
      },
    });
    const sent = h.nuvion
      .bankSends()
      .filter(
        (t) =>
          refs.includes(t.request.unique_reference) &&
          t.status === 'successful',
      );
    expect(ledger.map((l) => l.customerReference).sort()).toEqual(
      sent.map((t) => t.request.unique_reference).sort(),
    );
    const ledgerTotal = ledger.reduce((n, l) => n + BigInt(l.totalKobo), 0n);
    const standinTotal = sent.reduce(
      (n, t) => n + t.amountKobo + t.feeKobo,
      0n,
    );
    expect(ledgerTotal).toBe(standinTotal);
    // Nothing the stand-in failed or still holds is a completed ledger row.
    for (const t of h.nuvion.bankSends()) {
      if (
        refs.includes(t.request.unique_reference) &&
        t.status !== 'successful'
      ) {
        expect(
          ledger.some(
            (l) => l.customerReference === t.request.unique_reference,
          ),
        ).toBe(false);
      }
    }
  }

  // -------------------------------------------------------------------------

  describe('the split', () => {
    it("the school's share and WAWU's 15 add up to the fee to the kobo, on odd fees too, and the database holds it", async () => {
      for (const price of [PRICE, 10_000_001, 99, 1, 33_333_333, 7]) {
        const s = splitCourseFee(price);
        expect(s.schoolShareKobo + s.wawuShareKobo).toBe(price);
        expect(s.schoolShareKobo).toBe(Math.floor((price * 8500) / 10_000));
      }
      const c = await classAt(today(), { priceKobo: 10_000_001 });
      const p = await student();
      const id = await paidEnrolment(c, p);
      const row = await enrolmentOf(id);
      expect(row.schoolShareKobo).toBe(8_500_000);
      expect(row.wawuShareKobo).toBe(1_500_001);
      await settlements.run(later());
      const s = await settlementOf(id);
      expect(s.priceKobo).toBe(10_000_001);
      expect(s.schoolShareKobo + s.wawuShareKobo).toBe(s.priceKobo);
      const sends = sendsOf(s.id);
      expect(sends).toHaveLength(1);
      expect(sends[0].amountKobo).toBe(8_500_000n);
      await expect(
        h.prisma
          .$executeRaw`UPDATE "SchoolSettlement" SET "wawuShareKobo" = "wawuShareKobo" + 1 WHERE "id" = ${s.id}`,
      ).rejects.toThrow();
      finishSends([s.id], 'successful');
      await settlements.run(later());
      expect((await settlementOf(id)).status).toBe('paid');
      await ledgerEqualsStandin();
    });
  });

  describe('paying the school at the intake start', () => {
    it("after an enrolment the school's settlement equals the ruled amount and the ledger shows WAWU's share", async () => {
      const c = await classAt(today());
      const p = await student();
      const id = await paidEnrolment(c, p);
      const before = await enrolmentOf(id);
      expect(before.holdId).not.toBeNull();
      expect((await holdOf(before.holdId!)).status).toBe('held');
      const operationalBefore = h.nuvion.operational.availableKobo;

      await settlements.run(later());
      let s = await settlementOf(id);
      expect(s.action).toBe('payout');
      expect(s.schoolShareKobo).toBe(SCHOOL_SHARE);
      expect(s.wawuShareKobo).toBe(WAWU_SHARE);
      // Handed to Nuvion under our reference, not yet finished: still held.
      expect(s.status).toBe('sent');
      expect((await holdOf(s.holdId)).status).toBe('held');
      const sends = sendsOf(s.id);
      expect(sends).toHaveLength(1);
      expect(sends[0].request.unique_reference).toBe(`wawu-bank-sch-${s.id}`);
      expect(sends[0].request.account_number).toBe(c.account);
      expect(sends[0].amountKobo).toBe(BigInt(SCHOOL_SHARE));
      // The school gets its 85% in full; the bank charge is WAWU's (R-31).
      expect(h.nuvion.operational.availableKobo).toBe(
        operationalBefore - BigInt(SCHOOL_SHARE) - BANK_FEE,
      );

      finishSends([s.id], 'successful');
      await settlements.run(later());
      s = await settlementOf(id);
      expect(s.status).toBe('paid');
      expect(s.paidAt).not.toBeNull();
      expect(s.providerFeeKobo).toBe(BANK_FEE);
      expect((await holdOf(s.holdId)).status).toBe('released');
      expect((await enrolmentOf(id)).status).toBe('enrolled');

      // The ledger: WAWU's account took the fee in and paid the school's
      // share out, so what stays is WAWU's 15%, less the bank's charge.
      const payment = await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: before.paymentId! },
      });
      const money = await h.prisma.fintavaLedgerEntry.findMany({
        where: {
          OR: [
            { paymentId: payment.id },
            { customerReference: s.customerReference },
          ],
        },
      });
      const merchantIn = money.find(
        (m) => m.walletKind === 'merchant' && m.direction === 'in',
      );
      const merchantOut = money.find(
        (m) => m.walletKind === 'merchant' && m.direction === 'out',
      );
      expect(merchantIn).toBeDefined();
      expect(merchantOut).toBeDefined();
      expect(Number(merchantIn!.amountKobo)).toBe(PRICE);
      expect(Number(merchantOut!.amountKobo)).toBe(SCHOOL_SHARE);
      expect(Number(merchantOut!.feeKobo)).toBe(Number(BANK_FEE));
      expect(merchantOut!.category).toBe('earning');
      expect(
        Number(merchantIn!.amountKobo) - Number(merchantOut!.amountKobo),
      ).toBe(WAWU_SHARE);
      expect(
        Number(merchantIn!.amountKobo) - Number(merchantOut!.totalKobo),
      ).toBe(WAWU_SHARE - Number(BANK_FEE));
      await ledgerEqualsStandin();
    });

    it('a class that has not started is not paid; a class that has is paid on the day', async () => {
      const future = await classAt(inDays(5));
      const today_ = await classAt(today());
      const a = await student();
      const b = await student();
      const fa = await paidEnrolment(future, a);
      const fb = await paidEnrolment(today_, b);
      await settlements.run(later());
      expect(
        await h.prisma.schoolSettlement.findUnique({
          where: { enrolmentId: fa },
        }),
      ).toBeNull();
      expect((await settlementOf(fb)).action).toBe('payout');
      finishSends([(await settlementOf(fb)).id], 'successful');
      await settlements.run(later());
      await ledgerEqualsStandin();
    });

    it("a payout run twice in parallel pays once (five sweeps at once, three servers' worth)", async () => {
      const c = await classAt(today());
      const people = await Promise.all([student(), student(), student()]);
      const ids: string[] = [];
      for (const p of people) ids.push(await paidEnrolment(c, p));
      const before = h.nuvion.operational.availableKobo;
      await Promise.all(
        Array.from({ length: 5 }, () => settlements.run(later())),
      );
      const rows = await Promise.all(ids.map((i) => settlementOf(i)));
      for (const r of rows) {
        expect(sendsOf(r.id)).toHaveLength(1);
        expect(r.attempts).toBe(1);
      }
      expect(h.nuvion.operational.availableKobo).toBe(
        before - 3n * (BigInt(SCHOOL_SHARE) + BANK_FEE),
      );
      finishSends(
        rows.map((r) => r.id),
        'successful',
      );
      await Promise.all(
        Array.from({ length: 5 }, () => settlements.run(later())),
      );
      for (const r of rows) {
        expect((await settlementOf(r.enrolmentId)).status).toBe('paid');
        expect(sendsOf(r.id)).toHaveLength(1);
        expect((await holdOf(r.holdId)).status).toBe('released');
      }
      // Paid already: more sweeps send nothing.
      await Promise.all(
        Array.from({ length: 3 }, () => settlements.run(later())),
      );
      for (const r of rows) expect(sendsOf(r.id)).toHaveLength(1);
      await ledgerEqualsStandin();
    });

    it('a school with no confirmed bank account waits, the money stays held, and it is paid once the account is set', async () => {
      const c = await classAt(today(), { payee: false });
      const p = await student();
      const id = await paidEnrolment(c, p);
      await settlements.run(later());
      const waiting = await settlementOf(id);
      expect(waiting.status).toBe('pending');
      expect(waiting.waiting).toBe('no_payee');
      expect(sendsOf(waiting.id)).toHaveLength(0);
      expect((await holdOf(waiting.holdId)).status).toBe('held');
      // An account the bank does not know is refused and saves nothing.
      await expect(
        payees.set(
          c.schoolId,
          { bankCode: '058', accountNumber: '0000000000' },
          null,
        ),
      ).rejects.toThrow(/did not confirm/);
      await settlements.run(later());
      expect(sendsOf(waiting.id)).toHaveLength(0);
      h.nuvion.bankDirectory.set('058:5550001112', HOLDER);
      const view = await payees.set(
        c.schoolId,
        { bankCode: '058', accountNumber: '5550001112' },
        null,
      );
      expect(view.accountNumberLast4).toBe('1112');
      expect(view.accountName).toBe(HOLDER);
      await settlements.run(later());
      expect(sendsOf(waiting.id)).toHaveLength(1);
      finishSends([waiting.id], 'successful');
      await settlements.run(later());
      expect((await settlementOf(id)).status).toBe('paid');
      await ledgerEqualsStandin();
    });

    it('a provider that cannot be reached, or does not take the request, is waited out under the same reference', async () => {
      const c = await classAt(today());
      const id = await paidEnrolment(c, await student());
      h.nuvion.bankMode = 'not_sent';
      await settlements.run(later());
      let s = await settlementOf(id);
      expect(s.status).toBe('pending');
      expect(s.waiting).toBe('provider');
      expect(sendsOf(s.id)).toHaveLength(0);
      h.nuvion.bankMode = 'insufficient';
      await settlements.run(later(30 * 60_000));
      s = await settlementOf(id);
      expect(s.waiting).toBe('funds');
      expect(sendsOf(s.id)).toHaveLength(0);
      h.nuvion.bankMode = 'pending';
      await settlements.run(later(2 * 60 * 60_000));
      s = await settlementOf(id);
      expect(s.status).toBe('sent');
      expect(s.customerReference).toBe(`wawu-bank-sch-${s.id}`);
      expect(sendsOf(s.id)).toHaveLength(1);
      finishSends([s.id], 'successful');
      await settlements.run(later());
      expect((await settlementOf(id)).status).toBe('paid');
      await ledgerEqualsStandin();
    });
  });

  describe('a failed payout', () => {
    it('is retried once under a new reference and never doubles', async () => {
      const c = await classAt(today());
      const id = await paidEnrolment(c, await student());
      const operational = h.nuvion.operational.availableKobo;
      await settlements.run(later());
      let s = await settlementOf(id);
      const first = sendsOf(s.id);
      expect(first).toHaveLength(1);
      // Nuvion's own record says it failed: the money is back in WAWU's account.
      finishSends([s.id], 'failed');
      expect(h.nuvion.operational.availableKobo).toBe(operational);
      await settlements.run(later());
      s = await settlementOf(id);
      expect(s.status).toBe('pending');
      expect(s.attempt).toBe(2);
      expect(s.customerReference).toBe(`wawu-bank-sch-${s.id}-2`);
      expect(sendsOf(s.id)).toHaveLength(1);
      await settlements.run(later());
      s = await settlementOf(id);
      const both = sendsOf(s.id);
      expect(both.map((t) => t.request.unique_reference)).toEqual([
        `wawu-bank-sch-${s.id}`,
        `wawu-bank-sch-${s.id}-2`,
      ]);
      expect(h.nuvion.operational.availableKobo).toBe(
        operational - BigInt(SCHOOL_SHARE) - BANK_FEE,
      );
      // More sweeps before it finishes send nothing more.
      await Promise.all(
        Array.from({ length: 4 }, () => settlements.run(later())),
      );
      expect(sendsOf(s.id)).toHaveLength(2);
      finishSends([s.id], 'successful');
      await settlements.run(later());
      s = await settlementOf(id);
      expect(s.status).toBe('paid');
      expect(
        sendsOf(s.id).filter((t) => t.status === 'successful'),
      ).toHaveLength(1);
      expect((await holdOf(s.holdId)).status).toBe('released');
      await ledgerEqualsStandin();
    });

    it('that fails twice goes to a person, the money stays held, and nothing is sent a third time', async () => {
      const c = await classAt(today());
      const id = await paidEnrolment(c, await student());
      const operational = h.nuvion.operational.availableKobo;
      await settlements.run(later());
      let s = await settlementOf(id);
      finishSends([s.id], 'failed');
      await settlements.run(later());
      await settlements.run(later());
      finishSends([s.id], 'failed');
      await settlements.run(later());
      await settlements.run(later());
      s = await settlementOf(id);
      expect(s.status).toBe('review');
      expect(s.reviewNote).toContain('failed on its second try');
      expect(sendsOf(s.id)).toHaveLength(2);
      expect(h.nuvion.operational.availableKobo).toBe(operational);
      expect((await holdOf(s.holdId)).status).toBe('held');
      await Promise.all(
        Array.from({ length: 3 }, () => settlements.run(later())),
      );
      expect(sendsOf(s.id)).toHaveLength(2);
      await ledgerEqualsStandin();
    });

    it('whose answer is lost is asked about, never sent again, and is paid once it completes', async () => {
      const c = await classAt(today());
      const id = await paidEnrolment(c, await student());
      h.nuvion.bankMode = 'lost_answer';
      await settlements.run(later());
      let s = await settlementOf(id);
      expect(s.status).toBe('sent');
      expect(sendsOf(s.id)).toHaveLength(1);
      h.nuvion.bankMode = 'pending';
      await Promise.all(
        Array.from({ length: 4 }, () => settlements.run(later())),
      );
      expect(sendsOf(s.id)).toHaveLength(1);
      expect((await settlementOf(id)).status).toBe('sent');
      finishSends([s.id], 'successful');
      await settlements.run(later());
      s = await settlementOf(id);
      expect(s.status).toBe('paid');
      expect(sendsOf(s.id)).toHaveLength(1);
      expect(s.providerFeeKobo).toBe(BANK_FEE);
      await ledgerEqualsStandin();
    });
  });

  describe('a refund', () => {
    it('of an enrolment after the payout is refused and moves nothing', async () => {
      const c = await classAt(today());
      const p = await student();
      const id = await paidEnrolment(c, p);
      await settlements.run(later());
      const s0 = await settlementOf(id);
      // Handed to the bank, not finished: already on its way.
      await expect(settlements.refundEnrolment(id)).rejects.toThrow(
        /on its way to the school/,
      );
      finishSends([s0.id], 'successful');
      await settlements.run(later());
      expect((await settlementOf(id)).status).toBe('paid');
      const wallet = balance(p);
      const operational = h.nuvion.operational.availableKobo;
      const transfers = h.nuvion.transfers.length;
      await expect(settlements.refundEnrolment(id)).rejects.toThrow(
        /already been paid to the school/,
      );
      refundsSettleAtOnce();
      await expect(settlements.refundEnrolment(id)).rejects.toThrow(
        /already been paid/,
      );
      await settlements.run(later());
      const s = await settlementOf(id);
      expect(s.action).toBe('payout');
      expect(s.status).toBe('paid');
      expect((await holdOf(s.holdId)).status).toBe('released');
      expect((await enrolmentOf(id)).status).toBe('enrolled');
      expect(balance(p)).toBe(wallet);
      expect(h.nuvion.operational.availableKobo).toBe(operational);
      expect(h.nuvion.transfers).toHaveLength(transfers);
      await ledgerEqualsStandin();
    });

    it('of an enrolment before the payout goes to the student, the school is never paid, and the seat goes back', async () => {
      const c = await classAt(today(), { payee: false });
      const p = await student();
      const start = balance(p);
      const id = await paidEnrolment(c, p);
      // Paid: the price and the bank's charge left the wallet.
      expect(balance(p)).toBeLessThan(start - BigInt(PRICE));
      await settlements.run(later());
      expect((await settlementOf(id)).waiting).toBe('no_payee');
      const seats = (
        await h.prisma.courseIntake.findUniqueOrThrow({
          where: { id: c.intakeIds[0] },
        })
      ).seatsTaken;
      refundsSettleAtOnce();
      const view = await settlements.refundEnrolment(id);
      expect(view.action).toBe('refund');
      expect(view.status).toBe('refunded');
      const s = await settlementOf(id);
      expect((await holdOf(s.holdId)).status).toBe('refunded');
      const e = await enrolmentOf(id);
      expect(e.status).toBe('refunded');
      // The price comes back; the charge on the original payment does not (R-10).
      const paidTotal = Number(
        (
          await h.prisma.walletPayment.findUniqueOrThrow({
            where: { id: e.paymentId! },
          })
        ).totalKobo,
      );
      expect(balance(p)).toBe(start - BigInt(paidTotal - PRICE));
      expect(
        (
          await h.prisma.courseIntake.findUniqueOrThrow({
            where: { id: c.intakeIds[0] },
          })
        ).seatsTaken,
      ).toBe(seats - 1);
      // The account is set later: the school is never paid for it.
      await payees.set(
        c.schoolId,
        { bankCode: '058', accountNumber: c.account },
        null,
      );
      await Promise.all(
        Array.from({ length: 3 }, () => settlements.run(later())),
      );
      expect(sendsOf(s.id)).toHaveLength(0);
      expect((await settlementOf(id)).action).toBe('refund');
      // Asked again: the same answer, no second refund.
      const transfers = h.nuvion.transfers.length;
      const again = await settlements.refundEnrolment(id);
      expect(again.status).toBe('refunded');
      expect(h.nuvion.transfers).toHaveLength(transfers);
      await ledgerEqualsStandin();
    });

    it('a class called off sends every paid fee back, gives unpaid places back, and counts a fee already paid to the school', async () => {
      const c = await classAt(today());
      const early = await student();
      const idEarly = await paidEnrolment(c, early);
      await settlements.run(later());
      const sEarly = await settlementOf(idEarly);
      finishSends([sEarly.id], 'successful');
      await settlements.run(later());
      expect((await settlementOf(idEarly)).status).toBe('paid');

      const a = await student();
      const b = await student();
      const startA = balance(a);
      const idA = await paidEnrolment(c, a);
      const idB = await paidEnrolment(c, b);
      const unpaid = await student();
      const made = await h.enrol(unpaid, c.intakeIds[0]);
      expect(made.status).toBe(201);

      refundsSettleAtOnce();
      const out = await settlements.cancelIntake(c.intakeIds[0], later());
      expect(out.refunding).toBe(2);
      expect(out.alreadyPaidOut).toBe(1);
      expect(out.placesReleased).toBe(1);
      for (const id of [idA, idB]) {
        const s = await settlementOf(id);
        expect(s.action).toBe('refund');
        expect((await holdOf(s.holdId)).status).toBe('refunded');
        expect((await enrolmentOf(id)).status).toBe('refunded');
        expect(sendsOf(s.id)).toHaveLength(0);
      }
      expect(balance(a)).toBeGreaterThan(startA - BigInt(PRICE));
      // The fee already paid out stays with the school.
      expect((await settlementOf(idEarly)).action).toBe('payout');
      expect((await holdOf(sEarly.holdId)).status).toBe('released');
      // Asked again: the same counts and nothing moves twice.
      const transfers = h.nuvion.transfers.length;
      const again = await settlements.cancelIntake(c.intakeIds[0], later());
      expect(again.refunding).toBe(2);
      expect(again.alreadyPaidOut).toBe(1);
      expect(h.nuvion.transfers).toHaveLength(transfers);
      // A cancelled class takes no enrolments.
      await h.enrol(await student(), c.intakeIds[0]).expect(404);
      await settlements.run(later());
      expect(h.nuvion.transfers).toHaveLength(transfers);
      await ledgerEqualsStandin();
    });

    it('called off while the school is being paid: each fee goes one way only', async () => {
      const c = await classAt(today());
      const people = await Promise.all(
        Array.from({ length: 4 }, () => student()),
      );
      const ids: string[] = [];
      for (const p of people) ids.push(await paidEnrolment(c, p));
      refundsSettleAtOnce();
      await Promise.all([
        settlements.run(later()),
        settlements.cancelIntake(c.intakeIds[0], later()),
        settlements.run(later()),
        settlements.cancelIntake(c.intakeIds[0], later()),
      ]);
      // Finish whatever went to the bank, then settle everything.
      for (let i = 0; i < 3; i += 1) {
        for (const id of ids)
          finishSends([(await settlementOf(id)).id], 'successful');
        await settlements.run(later());
      }
      for (const id of ids) {
        const s = await settlementOf(id);
        const sends = sendsOf(s.id);
        const hold = await holdOf(s.holdId);
        if (s.action === 'payout') {
          expect(sends).toHaveLength(1);
          expect(s.status).toBe('paid');
          expect(hold.status).toBe('released');
          expect((await enrolmentOf(id)).status).toBe('enrolled');
        } else {
          expect(sends).toHaveLength(0);
          expect(s.status).toBe('refunded');
          expect(hold.status).toBe('refunded');
          expect((await enrolmentOf(id)).status).toBe('refunded');
        }
      }
      await ledgerEqualsStandin();
    });
  });

  describe('the dashboard routes', () => {
    it('are for finance and the superadmin; a user and a reviewer are refused; a payee is saved only when the bank confirms it', async () => {
      const finance = await h.adminAuth('finance');
      const reviewer = await h.adminAuth('reviewer');
      const c = await classAt(today(), { payee: false });
      const http = () => request(h.app.getHttpServer());
      const url = `/api/hub/admin/schools/${c.schoolId}/payee`;
      const account = c.account;

      await http().get(url).expect(401);
      await http()
        .put(url)
        .set({ Authorization: (await student()).auth })
        .send({ bankCode: '058', accountNumber: account })
        .expect(401);
      await http()
        .put(url)
        .set(reviewer)
        .send({ bankCode: '058', accountNumber: account })
        .expect(403);
      await http().get(url).set(finance).expect(404);
      await http()
        .put(url)
        .set(finance)
        .send({ bankCode: '058', accountNumber: '0000000000' })
        .expect(422);
      await http()
        .put(url)
        .set(finance)
        .send({ bankCode: '999', accountNumber: account })
        .expect(422);
      await http()
        .put(url)
        .set(finance)
        .send({ bankCode: '058', accountNumber: '12' })
        .expect(400);
      await http().get(url).set(finance).expect(404);
      const saved = body<SchoolPayeeView>(
        await http()
          .put(url)
          .set(finance)
          .send({ bankCode: '058', accountNumber: account })
          .expect(200),
      ).data!;
      expect(saved.accountName).toBe(HOLDER);
      expect(saved.bankName).toBe('Guaranty Trust Bank');
      expect(saved.accountNumberLast4).toBe(account.slice(-4));
      expect(JSON.stringify(saved)).not.toContain(account);
      expect(
        body<SchoolPayeeView>(await http().get(url).set(finance).expect(200))
          .data!.accountName,
      ).toBe(HOLDER);

      // A fee: refund it through the route before the school is paid.
      const p = await student();
      const id = await paidEnrolment(c, p);
      refundsSettleAtOnce();
      await http()
        .post(`/api/hub/admin/school-enrolments/${id}/refund`)
        .set(reviewer)
        .expect(403);
      const refunded = body<SchoolSettlementView>(
        await http()
          .post(`/api/hub/admin/school-enrolments/${id}/refund`)
          .set(finance)
          .expect(201),
      ).data!;
      expect(refunded.action).toBe('refund');
      expect(refunded.status).toBe('refunded');
      expect(refunded.schoolShareKobo + refunded.wawuShareKobo).toBe(
        refunded.priceKobo,
      );

      // A class: cancel it through the route; paid out ones are refused with 409.
      const d = await classAt(today());
      const q = await student();
      const idQ = await paidEnrolment(d, q);
      await settlements.run(later());
      await http()
        .post(`/api/hub/admin/school-enrolments/${idQ}/refund`)
        .set(finance)
        .expect(409);
      const cancelled = body<CancelIntakeView>(
        await http()
          .post(`/api/hub/admin/school-intakes/${d.intakeIds[0]}/cancel`)
          .set(finance)
          .expect(201),
      ).data!;
      expect(cancelled.alreadyPaidOut).toBe(1);
      expect(cancelled.refunding).toBe(0);
      await http()
        .post(`/api/hub/admin/school-intakes/${randomUUID()}/cancel`)
        .set(finance)
        .expect(404);

      const list = body<SchoolSettlementPage>(
        await http()
          .get(`/api/hub/admin/school-settlements?schoolId=${d.schoolId}`)
          .set(finance)
          .expect(200),
      ).data!;
      expect(list.items.map((i) => i.enrolmentId)).toEqual([idQ]);
      expect(list.items[0].schoolShareKobo).toBe(SCHOOL_SHARE);
      await http()
        .get('/api/hub/admin/school-settlements')
        .set(reviewer)
        .expect(403);
      finishSends([(await settlementOf(idQ)).id], 'successful');
      await settlements.run(later());
      await ledgerEqualsStandin();
      expect(holds).toBeDefined();
    });
  });
});
