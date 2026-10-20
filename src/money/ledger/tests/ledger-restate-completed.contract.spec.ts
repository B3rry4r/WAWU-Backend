import { randomUUID } from 'node:crypto';
import {
  bootSchoolNuvion,
  type SchoolNuvion,
} from '../../../../test/schools/school-nuvion-harness';
import { chargeDifferenceNote } from '../ledger-notes';
import { LedgerService } from '../ledger.service';

/**
 * FIX-74: `LedgerService.restateCompletedCharge`, on its own. A completed
 * payout row from WAWU's account takes the provider's own recorded charge for
 * that same reference, once, with an audit note; every other case changes
 * nothing. Rows are written through the ledger on the Nuvion stand-in's
 * harness (a real database; no provider is reached).
 */

jest.setTimeout(120_000);

const AMOUNT = 1_000_000n;
const QUOTED = 2_000n;
const REAL = 2_500n;
const ACCOUNT = '9990000074';
const AUDIT = "Restated to Nuvion's own record of";

describe('LedgerService.restateCompletedCharge (FIX-74)', () => {
  let h: SchoolNuvion;
  let ledger: LedgerService;
  const refs: string[] = [];

  beforeAll(async () => {
    h = await bootSchoolNuvion('fix74l');
    ledger = h.app.get(LedgerService);
  });

  afterAll(async () => {
    if (h) {
      await h.prisma.fintavaLedgerEntry.deleteMany({
        where: { customerReference: { in: refs } },
      });
      await h.close();
    }
  });

  /** A payout row written the way the school settlement writes it. */
  async function payout(
    o: {
      status?: 'pending' | 'completed' | 'failed';
      wawuFee?: number;
      wallet?: 'merchant' | 'user';
      discrepancy?: string;
    } = {},
  ): Promise<string> {
    const ref = `fix74-ledger-${randomUUID()}`;
    refs.push(ref);
    const userId = randomUUID();
    await ledger.record(
      {
        wallet:
          o.wallet === 'user'
            ? { kind: 'user', wawuUserId: userId, accountNumber: ACCOUNT }
            : { kind: 'merchant', accountNumber: ACCOUNT },
        direction: 'out',
        status: o.status ?? 'completed',
        category: 'earning',
        amountKobo: Number(AMOUNT),
        feeKobo: Number(QUOTED),
        totalKobo: Number(AMOUNT + QUOTED),
        providerFeeKobo: Number(QUOTED),
        wawuFeeKobo: o.wawuFee ?? 0,
        references: { customerReference: ref },
        source: 'send',
      },
      undefined,
      { quiet: true },
    );
    if (o.discrepancy) {
      await h.prisma.fintavaLedgerEntry.updateMany({
        where: { customerReference: ref },
        data: { discrepancy: o.discrepancy },
      });
    }
    return ref;
  }
  const rowOf = (ref: string) =>
    h.prisma.fintavaLedgerEntry.findFirstOrThrow({
      where: { customerReference: ref },
    });
  const audits = (d: string | null) => (d ?? '').split(AUDIT).length - 1;
  const restate = (
    ref: string,
    record: { ourReference: string | null; feeKobo: bigint | null },
    amount = AMOUNT,
  ) => ledger.restateCompletedCharge(ref, amount, record);

  it('restates a completed row to the provider charge, once, with an audit note', async () => {
    const ref = await payout();
    const before = await rowOf(ref);
    const at = new Date('2026-10-18T09:30:00.000Z');
    expect(
      await ledger.restateCompletedCharge(
        ref,
        AMOUNT,
        { ourReference: ref, feeKobo: REAL },
        at,
      ),
    ).toBe(true);
    const row = await rowOf(ref);
    expect(row.status).toBe('completed');
    expect(row.completedAt).toEqual(before.completedAt);
    expect(BigInt(row.feeKobo)).toBe(REAL);
    expect(BigInt(row.providerFeeKobo ?? 0)).toBe(REAL);
    expect(BigInt(row.totalKobo)).toBe(AMOUNT + REAL);
    expect(audits(row.discrepancy)).toBe(1);
    expect(row.discrepancy).toContain(ref);
    expect(row.discrepancy).toContain(`${AMOUNT + QUOTED}`);
    expect(row.discrepancy).toContain(`${AMOUNT + REAL}`);
    expect(row.discrepancy).toContain('2026-10-18T09:30:00.000Z');
    // The same record again: nothing more.
    expect(await restate(ref, { ourReference: ref, feeKobo: REAL })).toBe(
      false,
    );
    // A second record that states another charge: never twice.
    expect(await restate(ref, { ourReference: ref, feeKobo: 3_000n })).toBe(
      false,
    );
    const again = await rowOf(ref);
    expect(again.discrepancy).toBe(row.discrepancy);
    expect(BigInt(again.totalKobo)).toBe(AMOUNT + REAL);
  });

  it('five at once restate once', async () => {
    const ref = await payout();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        restate(ref, { ourReference: ref, feeKobo: REAL }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(audits((await rowOf(ref)).discrepancy)).toBe(1);
  });

  it('takes only the provider record of this very reference, with a stated charge', async () => {
    const ref = await payout();
    const other = `${ref}-other`;
    const before = await rowOf(ref);
    expect(await restate(ref, { ourReference: other, feeKobo: REAL })).toBe(
      false,
    );
    expect(await restate(ref, { ourReference: null, feeKobo: REAL })).toBe(
      false,
    );
    // The record names the row's reference but states no charge: silence is
    // never a figure.
    expect(await restate(ref, { ourReference: ref, feeKobo: null })).toBe(
      false,
    );
    expect(await restate(ref, { ourReference: ref, feeKobo: -1n })).toBe(false);
    // The row of another reference is not touched by a record naming this one.
    const bystander = await payout();
    expect(await restate(ref, { ourReference: ref, feeKobo: REAL })).toBe(true);
    const untouched = await rowOf(bystander);
    expect(BigInt(untouched.totalKobo)).toBe(AMOUNT + QUOTED);
    expect(untouched.discrepancy).toBeNull();
    expect(before.discrepancy).toBeNull();
  });

  it('a disagreement the record does not explain stays a flag and the row is left as it is', async () => {
    const cases: Array<[string, string]> = [
      ['an amount disagreement', 'amountKobo 1000000 vs 900000'],
      ['a status disagreement', 'status completed vs failed'],
      [
        'a charge note for another charge',
        chargeDifferenceNote('Nuvion', 3_000n, QUOTED),
      ],
      [
        'the charge note and another disagreement',
        `${chargeDifferenceNote('Nuvion', REAL, QUOTED)}; amountKobo 1000000 vs 900000`,
      ],
    ];
    for (const [, note] of cases) {
      const ref = await payout({ discrepancy: note });
      expect(await restate(ref, { ourReference: ref, feeKobo: REAL })).toBe(
        false,
      );
      const row = await rowOf(ref);
      expect(row.discrepancy).toBe(note);
      expect(BigInt(row.feeKobo)).toBe(QUOTED);
      expect(BigInt(row.totalKobo)).toBe(AMOUNT + QUOTED);
    }
  });

  it("the provider's own note for this very difference is explained, kept as the trail, and the audit note joins it", async () => {
    const note = chargeDifferenceNote('Nuvion', REAL, QUOTED);
    const ref = await payout({ discrepancy: note });
    expect(await restate(ref, { ourReference: ref, feeKobo: REAL })).toBe(true);
    const row = await rowOf(ref);
    expect(row.discrepancy!.startsWith(`${note}; ${AUDIT}`)).toBe(true);
    expect(audits(row.discrepancy)).toBe(1);
    expect(BigInt(row.totalKobo)).toBe(AMOUNT + REAL);
  });

  it('leaves alone a row that is not a settled payout of WAWU account at the record amount', async () => {
    const pending = await payout({ status: 'pending' });
    const failed = await payout({ status: 'failed' });
    const user = await payout({ wallet: 'user' });
    const withFee = await payout({ wawuFee: 25 });
    const wrongAmount = await payout();
    for (const ref of [pending, failed, user, withFee]) {
      const before = await rowOf(ref);
      expect(await restate(ref, { ourReference: ref, feeKobo: REAL })).toBe(
        false,
      );
      const after = await rowOf(ref);
      expect(after.status).toBe(before.status);
      expect(after.totalKobo).toBe(before.totalKobo);
      expect(after.discrepancy).toBe(before.discrepancy);
    }
    expect(
      await restate(
        wrongAmount,
        { ourReference: wrongAmount, feeKobo: REAL },
        AMOUNT + 1n,
      ),
    ).toBe(false);
    expect(BigInt((await rowOf(wrongAmount)).totalKobo)).toBe(AMOUNT + QUOTED);
    // A reference no row holds.
    const nobody = `fix74-ledger-${randomUUID()}`;
    expect(await restate(nobody, { ourReference: nobody, feeKobo: REAL })).toBe(
      false,
    );
  });

  it('restatePendingCharge is as it was: it restates a pending row and never a completed one', async () => {
    const pending = await payout({ status: 'pending' });
    expect(await ledger.restatePendingCharge(pending, AMOUNT, REAL)).toBe(true);
    const row = await rowOf(pending);
    expect(row.status).toBe('pending');
    expect(BigInt(row.totalKobo)).toBe(AMOUNT + REAL);
    expect(row.discrepancy).toBeNull();
    const completed = await payout();
    expect(await ledger.restatePendingCharge(completed, AMOUNT, REAL)).toBe(
      false,
    );
    expect(BigInt((await rowOf(completed)).totalKobo)).toBe(AMOUNT + QUOTED);
  });
});
