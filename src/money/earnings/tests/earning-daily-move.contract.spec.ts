import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  type PayHarness,
  type PayPerson,
  PAY_PIN,
  STAND_IN_FEE_KOBO,
} from '../../../../test/payments/wallet-pay-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import type {
  EarningsView,
  PaymentQuoteView,
  PaymentView,
} from '../../money-view.type';
import { PayableRegistry } from '../../payments/payable-registry';
import { PaymentSettings } from '../../payments/payment-config';
import { lagosDay, moveReference } from '../earning-rules';
import { EarningSettlementService } from '../earning-settlement.service';

/**
 * WALLET-16 round 3, ruling R-55 (owner, 16 Oct 2026): a creator's earnings go
 * to their wallet once a day in ONE transfer; a day's total under N200 waits
 * for the next day; an earning the wallet refuses goes in front of a person 72
 * hours after the FIRST refusal. Nuvion stood in (the shared pay harness): no
 * Nuvion, Fintava or wawuafrica.com host is called. The sweeps are given the
 * moment they run at, so a "day" here is a Lagos day a spec chose, not a wait.
 */

jest.setTimeout(180_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FEE = BigInt(STAND_IN_FEE_KOBO);
const shareOf = (priceKobo: number) => Math.floor((priceKobo * 85) / 100);

describe('One move a day per creator (WALLET-16, R-55), Nuvion stood in', () => {
  let h: PayHarness;
  let other: EarningSettlementService;
  const targets = new Map<string, { payee: string; priceKobo: number }>();
  /** Lagos midnight of a day far enough ahead that no real clock time reaches it. */
  const firstDay = lagosDay(new Date(Date.now() + 40 * DAY)).start.getTime();
  let dayCounter = 0;
  /** A fresh Lagos day for a spec, so what one spec moved never counts as another's day. */
  const nextDay = () => {
    dayCounter += 10;
    return firstDay + dayCounter * DAY;
  };
  const at = (dayStart: number, hours: number, minutes = 0) =>
    new Date(dayStart + hours * HOUR + minutes * 60_000);

  beforeAll(async () => {
    h = await bootPayApp('w16d', {
      modules: [],
      env: {
        EARNINGS_MOVE_MIN_KOBO: '',
        EARNINGS_REFUSED_REVIEW_AFTER_HOURS: '',
      },
      extra: (app) => {
        const registry = app.get(PayableRegistry);
        registry.register({
          kind: 'content_unlock',
          resolve: async ({ targetId }) => {
            await Promise.resolve();
            const t = targets.get(targetId);
            if (!t) throw new MoneyError('target_not_found', 'That is gone.');
            return {
              title: 'A piece',
              priceKobo: t.priceKobo,
              payee: {
                wawuUserId: t.payee,
                displayName: 'Adaeze Obi',
                handle: 'adaeze',
                avatarUrl: null,
                tick: 'creator' as const,
              },
            };
          },
          onCompleted: async () => {
            await Promise.resolve();
          },
        });
      },
    });
    // A second Hub process: its own service on the same database and provider.
    other = new EarningSettlementService(
      h.prisma,
      h.nuvion,
      h.app.get(LedgerService),
      h.app.get(FeeQuoteService),
      h.app.get(PaymentSettings),
    );
  });
  afterAll(async () => {
    await h.close();
  });

  /** A buyer pays `priceKobo` for a piece of `payee`; the payment completes at once. */
  async function sale(
    payee: PayPerson,
    priceKobo = 200_000,
  ): Promise<{ paymentId: string; buyer: PayPerson }> {
    const buyer = await h.person(50_000_000);
    const targetId = `piece-${randomUUID()}`;
    targets.set(targetId, { payee: payee.id, priceKobo });
    const qres = await h.get(
      buyer,
      `/money/payments/quote?kind=content_unlock&targetId=${targetId}`,
    );
    expect(qres.status).toBe(200);
    const q = body<PaymentQuoteView>(qres).data!;
    const res = await h.post(
      buyer,
      '/money/payments',
      {
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      },
      { pin: PAY_PIN },
    );
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    return { paymentId: view.id, buyer };
  }

  const toCreator = (p: PayPerson) =>
    h.nuvion.transfers.filter((t) => t.toAccountId === p.account!.accountId);
  const available = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  const movesOf = (p: PayPerson) =>
    h.prisma.earningMove.findMany({
      where: { payeeWawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
    });
  const earningOf = (paymentId: string) =>
    h.prisma.earningSettlement.findUniqueOrThrow({ where: { paymentId } });
  const ledgerOf = (reference: string) =>
    h.prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });

  /** Runs `fn` while Nuvion refuses every book transfer (compliance), then lets them through again. */
  async function refusing<T>(fn: () => Promise<T>): Promise<T> {
    h.nuvion.mode = 'compliance_rejected';
    try {
      return await fn();
    } finally {
      h.nuvion.mode = 'successful';
    }
  }

  /** A wallet opened for someone who had none (the person already signed in). */
  async function openWallet(p: PayPerson): Promise<PayPerson> {
    const accountNumber = `72${String(Date.now()).slice(-8)}`;
    const account = h.nuvion.openAccount(0n, accountNumber);
    await h.prisma.fintavaWallet.create({
      data: {
        wawuUserId: p.id,
        customerId: account.entityId,
        walletId: account.accountId,
        accountNumber,
        provider: 'nuvion',
      },
    });
    return { ...p, account, opening: 0n };
  }

  it('many sales in one day make exactly one transfer per creator, of their total', async () => {
    const day = nextDay();
    const a = await h.person(0);
    const b = await h.person(0);
    const prices = [200_001, 123_457, 99_999];
    const salesA = [] as Array<{ paymentId: string; buyer: PayPerson }>;
    for (const p of prices) salesA.push(await sale(a, p));
    const salesB = [await sale(b, 150_000), await sale(b, 150_000)];
    const totalA = prices.reduce((sum, p) => sum + shareOf(p), 0);

    const result = await h.earnings.sweep(at(day, 12));
    expect(result.planned).toBeGreaterThanOrEqual(2);

    expect(toCreator(a)).toHaveLength(1);
    expect(toCreator(b)).toHaveLength(1);
    expect(toCreator(a)[0].amountKobo).toBe(BigInt(totalA));
    expect(toCreator(b)[0].amountKobo).toBe(BigInt(2 * shareOf(150_000)));
    // WAWU's account paid Nuvion's charge once for the creator's day, not once a sale.
    expect(toCreator(a)[0].feeKobo).toBe(FEE);
    expect(available(a)).toBe(BigInt(totalA));

    const [move] = await movesOf(a);
    expect(await movesOf(a)).toHaveLength(1);
    expect(move).toMatchObject({
      status: 'landed',
      earnings: 3,
      dayKey: lagosDay(at(day, 12)).key,
      providerFeeKobo: FEE,
    });
    expect(move.amountKobo).toBe(BigInt(totalA));
    expect(move.customerReference).toBe(moveReference(a.id, move.dayKey, 1));
    expect(toCreator(a)[0].request.unique_reference).toBe(
      move.customerReference,
    );
    for (const s of salesA) {
      const e = await earningOf(s.paymentId);
      expect(e).toMatchObject({ status: 'landed', moveId: move.id });
      expect(e.settledAt).not.toBeNull();
      const pay = await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: s.paymentId },
        select: { payeeSettledAt: true },
      });
      expect(pay.payeeSettledAt).not.toBeNull();
    }
    // The ledger holds the one transfer: both sides, the total, one charge.
    const rows = await ledgerOf(move.customerReference);
    expect(rows).toHaveLength(2);
    const out = rows.find((r) => r.direction === 'out')!;
    const inn = rows.find((r) => r.direction === 'in')!;
    expect(inn.amountKobo).toBe(BigInt(totalA));
    expect(out.amountKobo).toBe(BigInt(totalA));
    expect(out.feeKobo).toBe(FEE);
    expect(inn.category).toBe('earning');
    expect(inn.linkKind).toBeNull();
    await h.expectLedgerEqualsStandIn([
      a,
      b,
      ...salesA.map((s) => s.buyer),
      ...salesB.map((s) => s.buyer),
    ]);
    expect(h.fintavaHits).toEqual([]);
  });

  it('two sweeps in one day, two servers or one, still make one transfer; a later sale waits for the next day', async () => {
    const day = nextDay();
    const a = await h.person(0);
    const s1 = await sale(a, 200_000);
    const s2 = await sale(a, 300_000);
    const first = at(day, 6);
    await Promise.all([h.earnings.sweep(first), other.sweep(first)]);
    await Promise.all([
      h.earnings.sweep(at(day, 6, 1)),
      other.sweep(at(day, 6, 1)),
    ]);
    expect(toCreator(a)).toHaveLength(1);
    expect(await movesOf(a)).toHaveLength(1);
    expect(available(a)).toBe(BigInt(shareOf(200_000) + shareOf(300_000)));

    // A sale made after the day's move: it waits, more sweeps the same day move nothing.
    const s3 = await sale(a, 400_000);
    await h.earnings.sweep(at(day, 18));
    await other.sweep(at(day, 23, 59));
    expect(toCreator(a)).toHaveLength(1);
    expect(await movesOf(a)).toHaveLength(1);
    const waiting = await earningOf(s3.paymentId);
    expect(waiting).toMatchObject({ status: 'owed', moveId: null });
    const view = body<EarningsView>(await h.get(a, '/money/earnings')).data!;
    expect(view.waiting).toEqual({ count: 1, amountKobo: shareOf(400_000) });
    expect(view.allTime.earnedKobo).toBe(
      shareOf(200_000) + shareOf(300_000) + shareOf(400_000),
    );

    // The next day it goes alone, in the one transfer of that day.
    await Promise.all([
      h.earnings.sweep(at(day + DAY, 0, 5)),
      other.sweep(at(day + DAY, 0, 5)),
    ]);
    expect(toCreator(a)).toHaveLength(2);
    expect(toCreator(a)[1].amountKobo).toBe(BigInt(shareOf(400_000)));
    expect(await movesOf(a)).toHaveLength(2);
    expect((await earningOf(s3.paymentId)).status).toBe('landed');
    await h.expectLedgerEqualsStandIn([a, s1.buyer, s2.buyer, s3.buyer]);
  });

  it('199.99 naira waits and is added to the next day’s move; exactly 200 naira moves', async () => {
    const day = nextDay();
    const a = await h.person(0);
    // 235.29 naira less 15% is 199.99 naira; 235.30 less 15% is exactly 200.
    expect(shareOf(23_529)).toBe(19_999);
    expect(shareOf(23_530)).toBe(20_000);
    const small = await sale(a, 23_529);
    await h.earnings.sweep(at(day, 12));
    await other.sweep(at(day, 13));
    expect(toCreator(a)).toHaveLength(0);
    expect(await movesOf(a)).toHaveLength(0);
    expect(await earningOf(small.paymentId)).toMatchObject({
      status: 'owed',
      moveId: null,
    });
    // Still earned, still waiting, never a balance.
    const view = body<EarningsView>(await h.get(a, '/money/earnings')).data!;
    expect(view.waiting).toEqual({ count: 1, amountKobo: 19_999 });

    // The next day it waits again alone, then another sale brings the total over.
    await h.earnings.sweep(at(day + DAY, 9));
    expect(toCreator(a)).toHaveLength(0);
    const more = await sale(a, 100_000);
    await h.earnings.sweep(at(day + DAY, 10));
    expect(toCreator(a)).toHaveLength(1);
    expect(toCreator(a)[0].amountKobo).toBe(BigInt(19_999 + shareOf(100_000)));
    expect((await earningOf(small.paymentId)).status).toBe('landed');
    expect((await earningOf(more.paymentId)).status).toBe('landed');

    // A day total of exactly 200 naira is enough.
    const c = await h.person(0);
    const exact = await sale(c, 23_530);
    await h.earnings.sweep(at(day + 2 * DAY, 9));
    expect(toCreator(c)).toHaveLength(1);
    expect(toCreator(c)[0].amountKobo).toBe(20_000n);
    await h.expectLedgerEqualsStandIn([
      a,
      c,
      small.buyer,
      more.buyer,
      exact.buyer,
    ]);
  });

  it('the first refusal starts the 72 hour clock, later refusals do not restart it, and a review row appears at 72 hours exactly once', async () => {
    const day = nextDay();
    const a = await h.person(0);
    const s = await sale(a, 200_000);
    const t0 = at(day, 8);
    h.nuvion.mode = 'compliance_rejected';
    try {
      await h.earnings.sweep(t0);
      let [move] = await movesOf(a);
      expect(move.waiting).toBe('refused');
      expect(move.firstRefusedAt).toEqual(t0);
      expect(move.reviewSince).toBeNull();
      expect(toCreator(a)).toHaveLength(0);

      // Later refusals, from either server, leave the first one where it is.
      for (const minutes of [3, 30, 8 * 60, 30 * 60, 71 * 60 + 30]) {
        const later = new Date(t0.getTime() + minutes * 60_000);
        await h.earnings.sweep(later);
        await other.sweep(later);
        [move] = await movesOf(a);
        expect(move.firstRefusedAt).toEqual(t0);
        expect(move.reviewSince).toBeNull();
      }
      // The look after the last refusal is set for the 72nd hour, not an hour past it.
      expect(move.nextAttemptAt!.getTime()).toBe(t0.getTime() + 72 * HOUR);
      await h.earnings.sweep(new Date(t0.getTime() + 72 * HOUR - 1000));
      expect((await movesOf(a))[0].reviewSince).toBeNull();

      // At 72 hours after the FIRST refusal it goes to a person.
      h.logger.lines.length = 0;
      await h.earnings.sweep(new Date(t0.getTime() + 72 * HOUR));
      [move] = await movesOf(a);
      expect(move.reviewSince).not.toBeNull();
      expect(move.discrepancy).toContain('72 hours');
      const markedAt = move.reviewSince;
      // Once: more sweeps, from either server, neither make a second review nor move it.
      for (const hours of [73, 80, 200]) {
        const later = new Date(t0.getTime() + hours * HOUR);
        await h.earnings.sweep(later);
        await other.sweep(later);
      }
      const moves = await movesOf(a);
      expect(moves).toHaveLength(1);
      expect(moves[0].reviewSince).toEqual(markedAt);
      expect(
        h.logger.lines.filter(
          (l) => l.includes(move.id) && l.includes('sent to review'),
        ),
      ).toHaveLength(1);
      // Nothing moved, the earning is still owed and still earned.
      expect(toCreator(a)).toHaveLength(0);
      expect((await earningOf(s.paymentId)).status).toBe('owed');
      expect(
        await h.prisma.earningMove.count({
          where: { payeeWawuUserId: a.id, reviewSince: { not: null } },
        }),
      ).toBe(1);
    } finally {
      h.nuvion.mode = 'successful';
    }
    await h.expectLedgerEqualsStandIn([a, s.buyer]);
  });

  it('a refused move that goes through later is still one transfer that day, and no second move is made beside it', async () => {
    const day = nextDay();
    const a = await h.person(0);
    const s1 = await sale(a, 200_000);
    await refusing(() => h.earnings.sweep(at(day, 20)));
    expect(toCreator(a)).toHaveLength(0);
    // A sale made meanwhile waits behind the open move.
    const s2 = await sale(a, 300_000);
    await refusing(() => h.earnings.sweep(at(day, 22)));
    expect(await movesOf(a)).toHaveLength(1);
    // The next day the open move lands: that is the day's one transfer, so the
    // new sale waits again; the day after, it goes alone.
    await h.earnings.sweep(at(day + DAY, 9));
    expect(toCreator(a)).toHaveLength(1);
    expect(toCreator(a)[0].amountKobo).toBe(BigInt(shareOf(200_000)));
    await h.earnings.sweep(at(day + DAY, 18));
    expect(await movesOf(a)).toHaveLength(1);
    expect((await earningOf(s2.paymentId)).moveId).toBeNull();
    await h.earnings.sweep(at(day + 2 * DAY, 9));
    expect(toCreator(a)).toHaveLength(2);
    expect(toCreator(a)[1].amountKobo).toBe(BigInt(shareOf(300_000)));
    await h.expectLedgerEqualsStandIn([a, s1.buyer, s2.buyer]);
  });

  it('a creator with no wallet keeps earning and is moved the day the wallet opens, the waiting earnings together in one transfer', async () => {
    const day = nextDay();
    let creator = h.walletless();
    const s1 = await sale(creator, 200_000);
    await h.earnings.sweep(at(day, 12));
    const s2 = await sale(creator, 100_000);
    await h.earnings.sweep(at(day + DAY, 12));
    expect(await earningOf(s1.paymentId)).toMatchObject({
      status: 'owed',
      moveId: null,
      waiting: 'payee_wallet',
    });
    expect(await movesOf(creator)).toHaveLength(0);
    const before = body<EarningsView>(
      await h.get(creator, '/money/earnings'),
    ).data!;
    expect(before.walletOpen).toBe(false);
    expect(before.waiting).toEqual({
      count: 2,
      amountKobo: shareOf(200_000) + shareOf(100_000),
    });
    expect(before.allTime.earnedKobo).toBe(shareOf(200_000) + shareOf(100_000));

    // The wallet opens on the third day; the move is made that day.
    creator = await openWallet(creator);
    const s3 = await sale(creator, 50_000);
    await h.earnings.sweep(at(day + 2 * DAY, 9));
    await other.sweep(at(day + 2 * DAY, 9, 1));
    expect(toCreator(creator)).toHaveLength(1);
    expect(toCreator(creator)[0].amountKobo).toBe(
      BigInt(shareOf(200_000) + shareOf(100_000) + shareOf(50_000)),
    );
    expect(available(creator)).toBe(
      BigInt(shareOf(200_000) + shareOf(100_000) + shareOf(50_000)),
    );
    for (const s of [s1, s2, s3]) {
      expect((await earningOf(s.paymentId)).status).toBe('landed');
    }
    const after = body<EarningsView>(
      await h.get(creator, '/money/earnings'),
    ).data!;
    expect(after.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(after.walletOpen).toBe(true);
    await h.expectLedgerEqualsStandIn([creator, s1.buyer, s2.buyer, s3.buyer]);
  });

  it('an earning whose sale stops being a finished one leaves the move before anything is sent; the rest goes under a new reference', async () => {
    const day = nextDay();
    const a = await h.person(0);
    const keep = await sale(a, 200_000);
    const pulled = await sale(a, 300_000);
    await refusing(() => h.earnings.sweep(at(day, 8)));
    const [first] = await movesOf(a);
    expect(first.earnings).toBe(2);
    // A person puts the second sale under review after the move was made.
    await h.prisma.walletPayment.update({
      where: { id: pulled.paymentId },
      data: { reviewSince: new Date() },
    });
    await h.earnings.sweep(at(day, 9));
    await h.earnings.sweep(at(day, 10));
    const [move] = await movesOf(a);
    expect(await movesOf(a)).toHaveLength(1);
    expect(move.id).toBe(first.id);
    expect(move.earnings).toBe(1);
    expect(move.amountKobo).toBe(BigInt(shareOf(200_000)));
    expect(move.attempt).toBe(2);
    expect(move.customerReference).toBe(moveReference(a.id, move.dayKey, 2));
    expect(move.status).toBe('landed');
    expect(toCreator(a)).toHaveLength(1);
    expect(toCreator(a)[0].amountKobo).toBe(BigInt(shareOf(200_000)));
    expect((await earningOf(keep.paymentId)).status).toBe('landed');
    const gone = await earningOf(pulled.paymentId);
    expect(gone).toMatchObject({ status: 'owed', moveId: null });
    expect(gone.reviewSince).not.toBeNull();
    await h.expectLedgerEqualsStandIn([a, keep.buyer, pulled.buyer]);
  });

  it('the database holds the rules: one open move per creator, an earning joins only its own creator’s unsent move, the first refusal and the review are never moved, a landed move never changes', async () => {
    const day = nextDay();
    const a = await h.person(0);
    const b = await h.person(0);
    const sa = await sale(a, 200_000);
    const sb = await sale(b, 200_000);
    await refusing(() => h.earnings.sweep(at(day, 8)));
    const [ma] = await movesOf(a);
    const [mb] = await movesOf(b);
    expect(ma.sentAt).toBeNull();

    // A second open move for the same creator and provider.
    await expect(
      h.prisma.earningMove.create({
        data: {
          payeeWawuUserId: a.id,
          dayKey: '2099-01-01',
          provider: 'nuvion',
          merchantAccountNumber: ma.merchantAccountNumber,
          amountKobo: 1n,
          earnings: 1,
          customerReference: `wawu-earn-d-test-${randomUUID()}`,
        },
      }),
    ).rejects.toThrow(/EarningMove_one_open_per_payee|Unique constraint/);
    // Nobody else's earning goes into this creator's move.
    await expect(
      h.prisma.earningSettlement.update({
        where: { paymentId: sb.paymentId },
        data: { moveId: ma.id },
      }),
    ).rejects.toThrow(/same person and provider/);
    // The first refusal is written once and the review mark is set once.
    expect(ma.firstRefusedAt).not.toBeNull();
    await expect(
      h.prisma.earningMove.update({
        where: { id: ma.id },
        data: { firstRefusedAt: new Date(ma.firstRefusedAt!.getTime() + HOUR) },
      }),
    ).rejects.toThrow(/first refusal is not moved/);
    await h.prisma.earningMove.update({
      where: { id: mb.id },
      data: { reviewSince: new Date() },
    });
    await expect(
      h.prisma.earningMove.update({
        where: { id: mb.id },
        data: { reviewSince: null },
      }),
    ).rejects.toThrow(/review mark is set once/);
    // Who the move is for, and which day, never change.
    await expect(
      h.prisma.earningMove.update({
        where: { id: ma.id },
        data: { payeeWawuUserId: b.id },
      }),
    ).rejects.toThrow(/never changes/);

    // A landed move, and the earnings in it, never change.
    await h.earnings.sweep(at(day, 12));
    const landed = (await movesOf(a))[0];
    expect(landed.status).toBe('landed');
    await expect(
      h.prisma.earningMove.update({
        where: { id: landed.id },
        data: { amountKobo: landed.amountKobo + 1n },
      }),
    ).rejects.toThrow(/landed move never changes/);
    await expect(
      h.prisma.earningSettlement.update({
        where: { paymentId: sa.paymentId },
        data: { moveId: null },
      }),
    ).rejects.toThrow(/landed earning stays in its move/);
    await h.expectLedgerEqualsStandIn([a, b, sa.buyer, sb.buyer]);
  });
});
