import { randomUUID } from 'node:crypto';
import {
  body,
  NuvionCashOut,
  type Person,
} from '../../../../test/points/cash-out-harness';
import { MoneyError } from '../../../money/money-error';
import {
  MerchantWallet,
  PAYMENTS_UNAVAILABLE_MESSAGE,
} from '../../../money/payments/merchant-wallet';
import { loadPlansConfig } from '../../../plans/plans-config';
import type {
  PointsConversionView,
  PointsConvertQuoteView,
} from '../points-convert-view.type';

/**
 * Convert points to cash (task POINTS-04, R-42, R-43) on the wallet provider
 * seam with NUVION stood in (`test/payments/nuvion-seam-standin.ts`): its
 * documented accounts, book transfers answered `pending` first, the fee on
 * top as `applicable_fee`, statuses and error types, no lookup by our
 * reference. WAWU's own account is Nuvion's operational account, and the cash
 * leaves it by a book transfer. No Nuvion, Fintava or wawuafrica.com host is
 * called.
 */

jest.setTimeout(300_000);

const RATE = loadPlansConfig().cashOut.per1000Points.kobo;
const cashFor = (points: number) => Math.floor((points * RATE) / 1000);
const FEE = 1500;

describe('Convert points to cash (POINTS-04) on the provider seam, Nuvion stood in', () => {
  const h = new NuvionCashOut();

  beforeAll(async () => {
    await h.boot();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
    h.nuvion.operational.availableKobo = 50_000_000n;
    h.nuvion.feeKobo = () => BigInt(FEE);
  });

  async function funded(points: number): Promise<Person> {
    const p = await h.person(0);
    await h.lots(p, [{ points, days: 60 }]);
    return p;
  }

  it('converts at the config rate by one book transfer out of the operational account, once', async () => {
    const p = await h.person(0);
    const [soon, late] = await h.lots(p, [
      { points: 700, days: 10 },
      { points: 1500, days: 90 },
    ]);
    const before = h.merchantBalance();
    const res = await h.convert(p, 1300);
    expect(res.status).toBe(201);
    const view = body<PointsConversionView>(res).data!;
    expect(view).toMatchObject({
      status: 'completed',
      points: 1300,
      cashKobo: cashFor(1300),
    });
    const sent = h.sendsOf(view.reference);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      fromAccountId: h.nuvion.operational.accountId,
      toAccountId: p.walletId,
      amountKobo: BigInt(cashFor(1300)),
      feeKobo: BigInt(FEE),
    });
    expect(sent[0].request.payment_type).toBe('book-transfer');
    expect(sent[0].request.unique_reference).toBe(`wawu-pts-${view.id}`);
    expect(h.balanceOf(p)).toBe(cashFor(1300));
    // WAWU's account paid the amount and Nuvion's charge (R-31).
    expect(before - h.merchantBalance()).toBe(cashFor(1300) + FEE);

    const lots = await h.prisma.pointLot.findMany({
      where: { id: { in: [soon, late] } },
      orderBy: { expiresAt: 'asc' },
    });
    expect(lots.map((l) => l.remaining)).toEqual([0, 1500 - 600]);
    const { conversion, hold } = await h.state(view.id);
    expect(conversion).toMatchObject({
      status: 'paid',
      provider: 'nuvion',
      merchantAccountNumber: h.nuvion.operational.nuvionBan,
      providerFeeKobo: BigInt(FEE),
    });
    expect(hold?.state).toBe('committed');
    const rows = await h.ledgerRows(view.reference);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      direction: 'out',
      walletKind: 'merchant',
      linkKind: 'points_cash_out',
      feeKobo: BigInt(FEE),
    });
    expect(rows[0]).toMatchObject({
      direction: 'in',
      wawuUserId: p.id,
      linkKind: 'points_cash_out',
    });
    expect(h.fintavaHits).toEqual([]);
  });

  it('Nuvion accepts the transfer as pending first: the points stay held until it says successful, and it is never sent again', async () => {
    const p = await funded(3000);
    h.nuvion.mode = 'pending';
    const res = await h.convert(p, 2000);
    const view = body<PointsConversionView>(res).data!;
    expect(res.status).toBe(201);
    expect(view.status).toBe('pending');
    expect(view.statusMessage).toMatch(/still confirming/);
    expect(await h.points.balanceOf(p.id)).toBe(1000);
    expect(h.balanceOf(p)).toBe(0);
    let st = await h.state(view.id);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');

    // Asked again before Nuvion has finished: still unknown, still one transfer.
    await h.cashOut.sweep(h.later());
    expect((await h.state(view.id)).conversion.status).toBe('held');
    expect(h.sendsOf(view.reference)).toHaveLength(1);

    h.nuvion.settle(view.reference, 'successful');
    await h.cashOut.sweep(h.later(10 * 60_000));
    st = await h.state(view.id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(2000));
    expect(await h.points.balanceOf(p.id)).toBe(1000);
    expect(await h.ledgerRows(view.reference)).toHaveLength(2);
  });

  it('Nuvion fails the transfer after accepting it: the points go back to their lots and the operational account is whole', async () => {
    const p = await h.person(0);
    const ids = await h.lots(p, [
      { points: 800, days: 12 },
      { points: 900, days: 75 },
    ]);
    const before = h.merchantBalance();
    h.nuvion.mode = 'pending';
    const view = body<PointsConversionView>(await h.convert(p, 1500)).data!;
    expect(view.status).toBe('pending');
    h.nuvion.settle(view.reference, 'failed');
    await h.cashOut.sweep(h.later(10 * 60_000));
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('cancelled');
    expect(st.hold?.state).toBe('released');
    const lots = await h.prisma.pointLot.findMany({
      where: { id: { in: ids } },
      orderBy: { expiresAt: 'asc' },
    });
    expect(lots.map((l) => l.remaining)).toEqual([800, 900]);
    expect(h.balanceOf(p)).toBe(0);
    expect(h.merchantBalance()).toBe(before);
    expect(await h.ledgerRows(view.reference)).toHaveLength(0);
    const shown = body<PointsConversionView>(await h.read(p, view.id)).data!;
    expect(shown.status).toBe('failed');
  });

  it('a lost answer after Nuvion took the transfer is found in its records and landed once', async () => {
    const p = await funded(3000);
    h.nuvion.mode = 'timeout';
    const view = body<PointsConversionView>(await h.convert(p, 1800)).data!;
    expect(view.status).toBe('pending');
    // Nuvion holds it as pending; the adapter has no id for it (the answer was lost).
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.nuvion.keptIds.has(view.reference)).toBe(false);
    h.nuvion.settle(view.reference, 'successful');
    h.nuvion.mode = 'successful';
    await h.cashOut.sweep(h.later(10 * 60_000));
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('paid');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(1800));
    expect(st.hold?.state).toBe('committed');
  });

  it.each([
    'insufficient',
    'account_not_active',
    'compliance_rejected',
    'limit',
    'rate_limited',
  ] as const)(
    'a refusal that moved nothing (%s) gives the points back and sends nothing',
    async (mode) => {
      const p = await funded(2500);
      h.nuvion.mode = mode;
      const res = await h.convert(p, 1000);
      expect(res.status).toBe(201);
      const view = body<PointsConversionView>(res).data!;
      expect(view.status).toBe('failed');
      expect(view.failureReason).toMatch(/points were given back/);
      expect(h.sendsOf(view.reference)).toHaveLength(0);
      expect(await h.points.balanceOf(p.id)).toBe(2500);
      const { conversion, hold } = await h.state(view.id);
      expect(conversion.status).toBe('cancelled');
      expect(hold?.state).toBe('released');
    },
  );

  it('a system error on the create says nothing about whether Nuvion made it: asked about, held, never sent again', async () => {
    const p = await funded(2500);
    h.nuvion.mode = 'system_error';
    h.nuvion.systemError = {
      type: 'error_system_timeout',
      httpStatus: 504,
      created: false,
    };
    const view = body<PointsConversionView>(await h.convert(p, 1000)).data!;
    expect(view.status).toBe('pending');
    h.nuvion.mode = 'successful';
    // Nuvion has no record: absent is not "nothing moved".
    let t = Date.now();
    for (let i = 0; i < 3; i += 1) {
      t += 5 * 3_600_000;
      await h.cashOut.sweep(new Date(t));
    }
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    expect(h.sendsOf(view.reference)).toHaveLength(0);
    expect(await h.points.balanceOf(p.id)).toBe(1500);
  });

  it('another amount than asked is a stop for a person with the points held', async () => {
    const p = await funded(2500);
    h.nuvion.extraKobo = 100n;
    try {
      const view = body<PointsConversionView>(await h.convert(p, 1000)).data!;
      expect(view.status).toBe('pending');
      const st = await h.state(view.id);
      expect(st.conversion.reviewSince).not.toBeNull();
      expect(st.hold?.state).toBe('held');
      expect(await h.ledgerRows(view.reference)).toHaveLength(0);
    } finally {
      h.nuvion.extraKobo = 0n;
    }
  });

  it('a reversed transfer is a stop for a person, not a payment and not a refund of the points', async () => {
    const p = await funded(2500);
    h.nuvion.mode = 'pending';
    const view = body<PointsConversionView>(await h.convert(p, 1000)).data!;
    h.nuvion.settle(view.reference, 'successful');
    h.nuvion.settle(view.reference, 'reversed');
    await h.cashOut.sweep(h.later(10 * 60_000));
    const st = await h.state(view.id);
    expect(st.conversion.reviewSince).not.toBeNull();
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    expect(st.conversion.discrepancy).toMatch(/reversed it/);
  });

  it("a wallet that is the other provider's is not paid into: nothing is held, the key is given back", async () => {
    const p = await funded(2500);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { provider: 'fintava' },
    });
    const key = randomUUID();
    const res = await h.convert(p, 1000, { key });
    expect(res.status).toBe(503);
    expect(body<unknown>(res).reason?.code).toBe('provider_unreachable');
    expect(await h.points.balanceOf(p.id)).toBe(2500);
    expect(
      await h.prisma.pointConversion.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it("POINTS-04 L3: WAWU's account unreadable before anything is written says the points are safe, and holds nothing", async () => {
    const p = await funded(2500);
    const merchant = h.moduleRef.get(MerchantWallet);
    const spy = jest
      .spyOn(merchant, 'account')
      .mockRejectedValueOnce(
        new MoneyError('provider_unreachable', PAYMENTS_UNAVAILABLE_MESSAGE),
      );
    try {
      const res = await h.convert(p, 1000);
      expect(res.status).toBe(503);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'provider_unreachable',
        message:
          'Payments are not available right now. Your points are safe. Try again in a moment.',
      });
      expect(JSON.stringify(res.body)).not.toContain('Your money is safe');
    } finally {
      spy.mockRestore();
    }
    expect(await h.points.balanceOf(p.id)).toBe(2500);
  });

  it('quotes the same figures on Nuvion', async () => {
    const p = await funded(2500);
    const q = body<PointsConvertQuoteView>(
      await h.quote(p, '?points=1000'),
    ).data!;
    expect(q).toMatchObject({
      points: 1000,
      cashKobo: cashFor(1000),
      feeKobo: 0,
      wawuPaysProviderCharge: true,
      canConvert: true,
      // Nuvion has no per-move cap setting.
      maximumPoints: null,
    });
  });
});

describe("Convert points to cash (POINTS-04) while the provider's fees are not set", () => {
  const h = new NuvionCashOut();

  beforeAll(async () => {
    await h.boot({
      NUVION_FEE_BOOK_TRANSFER: '',
      NUVION_FEE_BANK_PAYOUT: '',
      NUVION_FEE_INFLOW: '',
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('nothing is quoted, held or moved before the fees are set (R-42), and no PIN try is used', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    const res = await h.convert(p, 1000, { pin: '0000' });
    expect(res.status).toBe(503);
    expect(body<unknown>(res).reason?.code).toBe('fees_not_set');
    const q = await h.quote(p);
    expect(q.status).toBe(503);
    expect(body<unknown>(q).reason?.code).toBe('fees_not_set');
    expect(await h.points.balanceOf(p.id)).toBe(3000);
    expect(h.nuvion.calls.filter((c) => c.method === 'walletToWallet')).toEqual(
      [],
    );
    const pin = await h.prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(pin.failedTries).toBe(0);
    // Even for a person with no wallet, fees_not_set comes first.
    const none = h.noWallet();
    const res2 = await h.convert(none, 1000);
    expect(res2.status).toBe(503);
  });
});
