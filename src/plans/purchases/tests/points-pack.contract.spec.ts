import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminActor } from '../../../common/audit/admin-ops-audit.service';
import type { TransactionPage } from '../../../money/money-view.type';
import { OTHER_CURRENCY_MESSAGE } from '../../../money/payments/wallet-payment.service';
import {
  pointsSales,
  type PointsSale,
} from '../../../plan-settings/plan-setting-rules';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import type { MyPointsView } from '../../../points/points-view.type';
import {
  countIn,
  loadPlansConfig,
  percentOf,
  priceIn,
} from '../../plans-config';
import { PACK_NOT_FOUND_MESSAGE } from '../points-pack-rules';
import type {
  PointsPackPurchaseView,
  PointsPackQuoteView,
} from '../points-pack-view.type';

/**
 * POINTS-02 over HTTP: buy a points pack from the wallet, on the real
 * MoneyModule, PlansModule, PointsModule and PlanPurchasesModule, a real
 * database, real RS256 tokens and the real Fintava client over a socket to the
 * Fintava double. No provider host is called. Every price and figure is read
 * from the config the Hub reads (the file, then the settings an admin saved).
 */

jest.setTimeout(120_000);

const DAY = 86_400_000;
const config = loadPlansConfig();
const pack = config.packs[0];
const packPrice = priceIn(pack.price, 'NGN');
const packPoints = countIn(pack.points, 'NGN');
const founding = config.tiers.find((t) => t.packBonusPct > 0)!;
const plain = config.tiers.find((t) => t.packBonusPct === 0)!;
const RICH = 100 * packPrice;
/** What a sale charges for each thousand points, in kobo, rounded down. */
const perThousand = (s: PointsSale) =>
  Math.floor((s.priceKobo * 1000) / s.points);
const admin: AdminActor = {
  id: randomUUID(),
  email: 'points02@admin.test.wawu.dev',
  role: AdminRole.finance,
};

describe('Buy a points pack from the wallet (POINTS-02)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let settings: PlanSettingsService;

  beforeAll(async () => {
    h = await bootTierApp('p02');
    call = api(h);
    settings = h.get(PlanSettingsService);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  const data = <T>(res: Response) => body<T>(res).data!;
  const reasonOf = (res: Response) =>
    body<unknown>(res).reason as unknown as { code: string; message: string };
  const quoteRoute = (p: Person, query: Record<string, string | undefined>) =>
    request(h.app.getHttpServer())
      .get(
        `/api/hub/plans/purchases/quote?${new URLSearchParams(
          Object.entries(query).filter(
            (e): e is [string, string] => e[1] !== undefined,
          ),
        )}`,
      )
      .set('Authorization', p.auth);
  async function quoted(
    p: Person,
    packId: string = pack.id,
  ): Promise<PointsPackQuoteView> {
    const res = await quoteRoute(p, { kind: 'points_pack', packId });
    expect(res.status).toBe(200);
    return data<PointsPackQuoteView>(res);
  }
  const bodyFor = (q: PointsPackQuoteView, over: object = {}) => ({
    kind: 'points_pack',
    packId: q.packId,
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
    ...over,
  });
  /** Quote, then pay with the PIN: what the app does. */
  async function purchase(
    p: Person,
    packId: string = pack.id,
    opts: { key?: string } = {},
  ) {
    const q = await quoted(p, packId);
    const res = await call.buy(p, bodyFor(q), opts);
    return { q, res, view: data<PointsPackPurchaseView>(res) };
  }
  const sendsFrom = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);
  const lotsOf = (p: Person) =>
    h.prisma.pointLot.findMany({ where: { wawuUserId: p.id } });
  const pointsOf = async (p: Person) =>
    data<MyPointsView>(await call.points(p));
  const set = (key: string, value: number | null) =>
    settings.set(admin, { settings: { [key]: value } });
  async function hold(p: Person, tierId: string, activeUntil: Date) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId,
        activeFrom: new Date(Date.now() - 10 * DAY),
        activeUntil,
        productsIncluded: 3,
        pointsIncluded: 0,
        voiceIntroIncluded: false,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Check 1: a naira-billed person buys a pack from the wallet
  // ---------------------------------------------------------------------------

  it('check 1: pays the pack price in one debit, adds one lot of the pack points with the bought-points expiry, and answers the same purchase to every poll', async () => {
    const p = await h.buyer(RICH);
    const before = h.wallets.kobo.get(p.accountNumber)!;
    const startedAt = Date.now();

    const q = await quoted(p);
    expect(q).toMatchObject({
      kind: 'points_pack',
      packId: pack.id,
      currency: 'NGN',
      packMinor: packPrice,
      points: packPoints,
      bonusPercent: 0,
      bonusPoints: 0,
      totalPoints: packPoints,
      expiryDays: config.points.boughtExpiryDays,
      paymentKind: 'points_pack',
    });
    expect(q.payment).toMatchObject({
      kind: 'points_pack',
      targetId: `pack-${pack.id}`,
      priceKobo: packPrice,
    });
    expect(q.payment.totalKobo).toBeGreaterThan(packPrice);

    const res = await call.buy(p, bodyFor(q));
    expect(res.status).toBe(201);
    const view = data<PointsPackPurchaseView>(res);
    expect(view).toMatchObject({
      kind: 'points_pack',
      packId: pack.id,
      method: 'wallet',
      currency: 'NGN',
      amountMinor: packPrice,
      points: packPoints,
      bonusPoints: 0,
      status: 'paid',
      statusMessage: null,
      transfer: null,
      payment: { kind: 'points_pack', status: 'completed', delivered: true },
      grant: { points: packPoints, bonusPoints: 0, totalPoints: packPoints },
    });
    expect(view.paidAt).not.toBeNull();
    const expiresAt = Date.parse(view.grant!.expiresAt);
    expect(expiresAt).toBeGreaterThan(
      startedAt + config.points.boughtExpiryDays * DAY - 1_000,
    );
    expect(expiresAt).toBeLessThan(
      Date.now() + config.points.boughtExpiryDays * DAY + 1_000,
    );

    // One debit at the price, the provider's charge on top.
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0].amountKobo).toBe(packPrice);
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(
      before - packPrice - sendsFrom(p)[0].feeKobo,
    );
    expect(view.payment!.totalKobo).toBe(q.payment.totalKobo);

    // One lot, keyed by the payment, of the pack's points.
    const lots = await lotsOf(p);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      source: 'pack',
      sourceRef: view.payment!.id,
      quantity: packPoints,
      remaining: packPoints,
    });
    expect(lots[0].expiresAt.getTime()).toBe(expiresAt);
    expect((await pointsOf(p)).balance).toBe(packPoints);

    // The currency is fixed by the first purchase, as a tier's is.
    expect(
      await h.prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      }),
    ).toMatchObject({
      currency: 'NGN',
      fixedBy: 'first_purchase',
      purchaseRef: view.payment!.id,
    });

    // The poll answers the same purchase; another person's is a 404.
    const polled = await call.read(p, view.id);
    expect(polled.status).toBe(200);
    expect(data<PointsPackPurchaseView>(polled)).toMatchObject({
      id: view.id,
      status: 'paid',
      grant: { totalPoints: packPoints },
    });
    const other = await h.buyer(RICH);
    expect((await call.read(other, view.id)).status).toBe(404);

    // The history names it.
    const page = await request(h.app.getHttpServer())
      .get('/api/hub/money/transactions')
      .set('Authorization', p.auth);
    const rows = body<TransactionPage>(page).data!.items.filter(
      (r) => r.link?.kind === 'points_pack',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'out',
      category: 'purchase',
      status: 'completed',
      description: `Bought points · Points pack ${pack.id.toUpperCase()}`,
    });
    expect(rows[0].description).not.toMatch(/\u2014/);
  });

  it('every pack in the plans file can be bought, at its own price and points', async () => {
    const p = await h.buyer(RICH * config.packs.length);
    for (const k of config.packs) {
      const { view } = await purchase(p, k.id);
      expect(view).toMatchObject({
        status: 'paid',
        amountMinor: priceIn(k.price, 'NGN'),
        grant: { points: countIn(k.points, 'NGN') },
      });
    }
    const total = config.packs.reduce(
      (n, k) => n + countIn(k.points, 'NGN'),
      0,
    );
    expect((await pointsOf(p)).balance).toBe(total);
    expect(await lotsOf(p)).toHaveLength(config.packs.length);
  });

  // ---------------------------------------------------------------------------
  // Check 2: a Founding Maker gets the pack plus the config bonus, rounded down
  // ---------------------------------------------------------------------------

  it('check 2: a person on the Founding tier gets the pack plus the tier percent, rounded down, shown in the quote, the purchase and the one lot', async () => {
    // 1,005 x 10 percent is 100.5: the half point is not given.
    await set(`plan.pack.${pack.id}.points`, 1005);
    try {
      const p = await h.buyer(RICH);
      await hold(p, founding.id, new Date(Date.now() + 100 * DAY));
      const bonus = percentOf(1005, founding.packBonusPct);
      expect(bonus).toBe(100);

      const q = await quoted(p);
      expect(q).toMatchObject({
        points: 1005,
        bonusPercent: founding.packBonusPct,
        bonusPoints: bonus,
        totalPoints: 1005 + bonus,
      });
      const res = await call.buy(p, bodyFor(q));
      expect(res.status).toBe(201);
      const view = data<PointsPackPurchaseView>(res);
      expect(view).toMatchObject({
        status: 'paid',
        points: 1005,
        bonusPoints: bonus,
        grant: {
          points: 1005,
          bonusPoints: bonus,
          totalPoints: 1005 + bonus,
        },
      });
      const lots = await lotsOf(p);
      expect(lots).toHaveLength(1);
      expect(lots[0]).toMatchObject({
        source: 'pack',
        quantity: 1005 + bonus,
      });
      // The price is the pack's: the bonus costs nothing more.
      expect(view.amountMinor).toBe(packPrice);
      expect(sendsFrom(p)[0].amountKobo).toBe(packPrice);
      expect((await pointsOf(p)).balance).toBe(1005 + bonus);
    } finally {
      await set(`plan.pack.${pack.id}.points`, null);
    }
  });

  it('the bonus percent is the setting, not a literal: a changed setting is the next quote, and a person with no bonus, an ended tier or a tier that gives none gets none', async () => {
    const key = `plan.tier.${founding.id}.pack_bonus_pct`;
    await set(key, 25);
    try {
      const p = await h.buyer(RICH);
      await hold(p, founding.id, new Date(Date.now() + 100 * DAY));
      const q = await quoted(p);
      expect(q).toMatchObject({
        bonusPercent: 25,
        bonusPoints: percentOf(packPoints, 25),
        totalPoints: packPoints + percentOf(packPoints, 25),
      });
      // Ending (a few days left) still runs: the bonus holds.
      const ending = await h.buyer(RICH);
      await hold(ending, founding.id, new Date(Date.now() + 2 * DAY));
      expect((await quoted(ending)).bonusPercent).toBe(25);
      // An ended tier gives no bonus.
      const ended = await h.buyer(RICH);
      await hold(ended, founding.id, new Date(Date.now() - DAY));
      expect(await quoted(ended)).toMatchObject({
        bonusPercent: 0,
        bonusPoints: 0,
        totalPoints: packPoints,
      });
      // A tier that gives none, and a person with no tier, get none.
      const lower = await h.buyer(RICH);
      await hold(lower, plain.id, new Date(Date.now() + 100 * DAY));
      expect((await quoted(lower)).bonusPercent).toBe(0);
      const nobody = await h.buyer(RICH);
      expect((await quoted(nobody)).bonusPoints).toBe(0);
      // And what is bought is what was quoted: the lot has the 25 percent.
      const paid = await call.buy(p, bodyFor(q));
      expect(data<PointsPackPurchaseView>(paid).grant).toMatchObject({
        bonusPoints: percentOf(packPoints, 25),
      });
    } finally {
      await set(key, null);
    }
  });

  // ---------------------------------------------------------------------------
  // Check 3: once, however often it is asked (V8)
  // ---------------------------------------------------------------------------

  it('check 3: the same request twice debits once and adds once; the replay is the first answer', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p);
    const key = randomUUID();
    const first = await call.buy(p, bodyFor(q), { key });
    expect(first.status).toBe(201);
    const second = await call.buy(p, bodyFor(q), { key, pin: '0000' });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(data(second)).toEqual(data(first));
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
    expect((await pointsOf(p)).balance).toBe(packPoints);
  });

  it('check 3: ten taps at once with one key debit once and add once', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p);
    const key = randomUUID();
    const taps = await Promise.all(
      Array.from({ length: 10 }, () => call.buy(p, bodyFor(q), { key })),
    );
    expect(taps.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(
      1,
    );
    for (const r of taps) expect([201, 409]).toContain(r.status);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
  });

  it('check 3: a payment delivered again (the sweep after a lost answer) adds nothing; a second pack is a second lot', async () => {
    const p = await h.buyer(RICH);
    const { view } = await purchase(p);
    const row = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.payment!.id },
    });
    const handler = h.registry.get('points_pack')!;
    const delivered = {
      paymentId: row.id,
      payerWawuUserId: p.id,
      kind: 'points_pack' as const,
      targetId: row.targetId,
      priceKobo: Number(row.priceKobo),
      payeeWawuUserId: null,
      note: null,
      holdId: null,
      terms: row.terms as Record<string, string | number | boolean>,
    };
    await handler.onCompleted!(delivered);
    await handler.onCompleted!(delivered);
    await Promise.all([
      handler.onCompleted!(delivered),
      handler.onCompleted!(delivered),
    ]);
    expect(await lotsOf(p)).toHaveLength(1);
    expect((await pointsOf(p)).balance).toBe(packPoints);

    await purchase(p);
    expect(await lotsOf(p)).toHaveLength(2);
    expect((await pointsOf(p)).balance).toBe(2 * packPoints);
  });

  // ---------------------------------------------------------------------------
  // The quote binds price and goods
  // ---------------------------------------------------------------------------

  it('a pack price changed after the quote is 409 quote_changed; nothing moves', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p);
    await set(`plan.pack.${pack.id}.price_kobo`, packPrice + 10_000);
    try {
      const res = await call.buy(p, bodyFor(q));
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('quote_changed');
    } finally {
      await set(`plan.pack.${pack.id}.price_kobo`, null);
    }
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
  });

  it('the points changed after the quote at the same price is 409 quote_changed, and so is the bonus or the expiry; the new quote is bought as quoted', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p);
    await set(`plan.pack.${pack.id}.points`, packPoints + 500);
    try {
      const res = await call.buy(p, bodyFor(q));
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('quote_changed');
      const fresh = await quoted(p);
      expect(fresh.totalPoints).toBe(packPoints + 500);
      const ok = await call.buy(p, bodyFor(fresh));
      expect(data<PointsPackPurchaseView>(ok).grant!.totalPoints).toBe(
        packPoints + 500,
      );
    } finally {
      await set(`plan.pack.${pack.id}.points`, null);
    }
    const q2 = await quoted(p);
    await set('points.expiry_months', 6);
    try {
      const res = await call.buy(p, bodyFor(q2));
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('quote_changed');
    } finally {
      await set('points.expiry_months', null);
    }
    // A person who became a Founding Maker after the quote: the bonus is new goods.
    const q3 = await quoted(p);
    await hold(p, founding.id, new Date(Date.now() + 100 * DAY));
    const res = await call.buy(p, bodyFor(q3));
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('quote_changed');
  });

  it('a setting changed while the payment confirms does not change what it adds: the lot is what was quoted', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p);
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, bodyFor(q));
    h.wallets.mode = 'live';
    const pending = data<PointsPackPurchaseView>(res);
    expect(pending.status).toBe('pending');
    expect(pending.grant).toBeNull();
    expect(await lotsOf(p)).toHaveLength(0);
    await set(`plan.pack.${pack.id}.points`, packPoints + 700);
    await set('points.expiry_months', 1);
    try {
      await h.sweepLater();
      const done = data<PointsPackPurchaseView>(await call.read(p, pending.id));
      expect(done.status).toBe('paid');
      expect(done.grant!.totalPoints).toBe(packPoints);
      const lots = await lotsOf(p);
      expect(lots).toHaveLength(1);
      expect(lots[0].quantity).toBe(packPoints);
      // The quoted expiry (a year), not the month the setting says by now.
      expect(lots[0].expiresAt.getTime()).toBeGreaterThan(
        Date.now() + (config.points.boughtExpiryDays - 1) * DAY,
      );
      expect(sendsFrom(p)).toHaveLength(1);
    } finally {
      await set(`plan.pack.${pack.id}.points`, null);
      await set('points.expiry_months', null);
    }
  });

  // ---------------------------------------------------------------------------
  // Refusals
  // ---------------------------------------------------------------------------

  it('a pack the plans file does not name is 404 target_not_found; a malformed pack id, a missing one and a request that mixes a plan with a pack are 400', async () => {
    const p = await h.buyer(RICH);
    const unknown = await quoteRoute(p, {
      kind: 'points_pack',
      packId: 'nonesuch',
    });
    expect(unknown.status).toBe(404);
    expect(reasonOf(unknown)).toMatchObject({
      code: 'target_not_found',
      message: PACK_NOT_FOUND_MESSAGE,
    });
    for (const query of [
      { kind: 'points_pack', packId: 'Bad-Id' },
      { kind: 'points_pack' },
      { kind: 'points_pack', packId: pack.id, tierId: founding.id },
      { kind: 'points_pack', packId: pack.id, bump: 'true' },
      { kind: 'tier', tierId: founding.id, packId: pack.id },
      { kind: 'tier' },
    ])
      expect((await quoteRoute(p, query)).status).toBe(400);

    const q = await quoted(p);
    for (const over of [
      { tierId: founding.id },
      { bump: true },
      { packId: undefined },
      { packId: 'Bad-Id' },
      { kind: 'tier', tierId: founding.id, packId: pack.id },
    ])
      expect((await call.buy(p, bodyFor(q, over))).status).toBe(400);
    expect((await call.buy(p, bodyFor(q, { packId: 'nonesuch' }))).status).toBe(
      404,
    );
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
  });

  it('not enough money is 402 insufficient_funds with the shortfall; nothing is added and the key is given back', async () => {
    const p = await h.buyer(1_000);
    const q = await quoted(p);
    const key = randomUUID();
    const res = await call.buy(p, bodyFor(q), { key });
    expect(res.status).toBe(402);
    expect(reasonOf(res).code).toBe('insufficient_funds');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
    h.wallets.kobo.set(p.accountNumber, RICH);
    const again = await call.buy(p, bodyFor(q), { key });
    expect(again.status).toBe(201);
    expect(await lotsOf(p)).toHaveLength(1);
  });

  it('a person without a wallet is 409 wallet_not_open', async () => {
    const p = await h.walletless();
    const res = await quoteRoute(p, { kind: 'points_pack', packId: pack.id });
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('wallet_not_open');
  });

  it('a person billed in dollars is not sold a pack for the naira wallet: no dollar pack is sold, nothing is taken or added', async () => {
    const p = await h.buyer(RICH);
    await h.prisma.personBilling.create({
      data: { wawuUserId: p.id, currency: 'USD', fixedBy: 'support' },
    });
    const res = await quoteRoute(p, { kind: 'points_pack', packId: pack.id });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toMatchObject({
      code: 'target_not_payable',
      message: OTHER_CURRENCY_MESSAGE,
    });
    const buy = await call.buy(p, {
      kind: 'points_pack',
      packId: pack.id,
      method: 'wallet',
      expectedTotalKobo: 100,
      quoteToken: 'x',
    });
    expect(buy.status).toBe(409);
    expect(reasonOf(buy).code).toBe('target_not_payable');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
  });

  it('the payment routes take the kind too: GET /money/payments/quote for pack-<id> is the same quote', async () => {
    const p = await h.buyer(RICH);
    const res = await request(h.app.getHttpServer())
      .get(
        `/api/hub/money/payments/quote?kind=points_pack&targetId=pack-${pack.id}`,
      )
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    const direct = data<{ priceKobo: number; totalKobo: number }>(res);
    const q = await quoted(p);
    expect(direct.priceKobo).toBe(q.payment.priceKobo);
    expect(direct.totalKobo).toBe(q.payment.totalKobo);
    // A pack and a tier are different payments: one open tier payment does not stop a pack.
    const tierQuote = await call.quote(p, { kind: 'tier', tierId: plain.id });
    expect(tierQuote.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // The cash-out rule counts the Founding bonus (TIER-06 round 2, low 2)
  // ---------------------------------------------------------------------------

  it('the cash rate may not exceed the price per point of a pack bought with the Founding bonus: a rate that fits every sale without the bonus is refused, and the percent is judged too', async () => {
    const rateKey = 'points.cash_rate_kobo_per_1000';
    const pctKey = `plan.tier.${founding.id}.pack_bonus_pct`;
    const ceiling = (points: (k: (typeof config.packs)[number]) => number) =>
      Math.min(
        ...config.packs.map((k) =>
          Math.floor((priceIn(k.price, 'NGN') * 1000) / points(k)),
        ),
        Math.floor(
          (priceIn(config.checkoutBump.price, 'NGN') * 1000) /
            countIn(config.checkoutBump.points, 'NGN'),
        ),
        priceIn(config.points.pricePer1000Points, 'NGN'),
      );
    const plainCeiling = ceiling((k) => countIn(k.points, 'NGN'));
    const bonusCeiling = ceiling(
      (k) =>
        countIn(k.points, 'NGN') +
        percentOf(countIn(k.points, 'NGN'), founding.packBonusPct),
    );
    // The bonus makes a pack sell a point for less than any other way does,
    // so the ceiling is lower than it was before the bonus was counted.
    expect(bonusCeiling).toBeLessThan(plainCeiling);
    expect(Math.min(...pointsSales(config).map(perThousand))).toBe(
      bonusCeiling,
    );

    await expect(set(rateKey, plainCeiling)).rejects.toThrow(
      new RegExp(pctKey.replace(/\./g, '\\.')),
    );
    await set(rateKey, bonusCeiling);
    try {
      // Raising the bonus percent so that the rate at the ceiling is breached is refused too.
      await expect(set(pctKey, 90)).rejects.toThrow(/pack_bonus_pct/);
      // Lowering it never is.
      await set(pctKey, 5);
    } finally {
      await set(pctKey, null);
      await set(rateKey, null);
    }
  });
});
