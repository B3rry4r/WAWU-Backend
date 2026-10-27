import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  liveFee,
  type Person,
  PIN,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import type { PaymentKind } from '../../../money/dto/money-enums';
import type { TransactionPage } from '../../../money/money-view.type';
import {
  OTHER_CURRENCY_MESSAGE,
  PAYMENT_FAILED_REASON,
  STILL_CONFIRMING_MESSAGE,
} from '../../../money/payments/wallet-payment.service';
import type { MyPointsView } from '../../../points/points-view.type';
import {
  loadPlansConfig,
  priceIn,
  countIn,
  tierById,
} from '../../plans-config';
import type { MyTierView } from '../../plans-view.type';
import {
  NO_DOWNGRADE_MESSAGE,
  PLAN_NOT_FOUND_MESSAGE,
  PLAN_RUNNING_MESSAGE,
} from '../plan-purchase-rules';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03 over HTTP: buy, renew and upgrade a tier from the wallet, on the
 * real MoneyModule, PlansModule, PointsModule and PlanPurchasesModule, a real
 * database, real RS256 tokens and the real Fintava client over a socket to
 * the Fintava double (docs/fintava/fees.md rates). No provider host is called.
 * Every price and figure is read from the config the Hub reads.
 */

jest.setTimeout(120_000);

const reasonOf = (res: Response) => body<unknown>(res).reason!;

const DAY = 86_400_000;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const middle = byPrice[1];
const big = byPrice[byPrice.length - 1];
const bumpKobo = priceIn(config.checkoutBump.price, 'NGN');
const bumpPoints = countIn(config.checkoutBump.points, 'NGN');
/** Plenty for a few purchases and their charges. */
const RICH = 100 * priceIn(big.price, 'NGN');

describe('Buy, renew or upgrade a tier from the wallet (TIER-03)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootTierApp('t03');
    call = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  type Terms = {
    kind: 'tier' | 'renew' | 'upgrade';
    tierId: string;
    bump?: boolean;
  };

  async function quoted(p: Person, t: Terms): Promise<PlanPurchaseQuoteView> {
    const res = await call.quote(p, t);
    expect(res.status).toBe(200);
    return body<PlanPurchaseQuoteView>(res).data!;
  }
  const bodyFor = (t: Terms, q: PlanPurchaseQuoteView, over: object = {}) => ({
    kind: t.kind,
    tierId: t.tierId,
    ...(t.bump === undefined ? {} : { bump: t.bump }),
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
    ...over,
  });
  /** Quote, then pay with the PIN: what the app does. */
  async function purchase(
    p: Person,
    t: Terms,
    opts: { key?: string; pin?: string | null } = {},
  ) {
    const q = await quoted(p, t);
    const res = await call.buy(p, bodyFor(t, q), opts);
    return { q, res, view: body<PlanPurchaseView>(res).data! };
  }
  const sendsFrom = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);
  const tierOf = async (p: Person) =>
    body<MyTierView>(await call.tier(p)).data!;
  const pointsOf = async (p: Person) =>
    body<MyPointsView>(await call.points(p)).data!;
  const rowsOf = (p: Person) =>
    h.prisma.makerPurchase.findMany({ where: { wawuUserId: p.id } });
  const lotsOf = (p: Person) =>
    h.prisma.pointLot.findMany({ where: { wawuUserId: p.id } });

  // ---------------------------------------------------------------------------
  // Check 1: a person with enough money buys a tier
  // ---------------------------------------------------------------------------

  it('check 1: buys the biggest tier with one debit at the config price, and the tier, its dates, the bonus lot, the event pass and the Voice Intro show in /me/tier and /me/points', async () => {
    const p = await h.buyer(RICH);
    const price = priceIn(big.price, 'NGN');
    const before = h.wallets.kobo.get(p.accountNumber)!;
    const startedAt = Date.now();

    const q = await quoted(p, { kind: 'tier', tierId: big.id });
    expect(q).toMatchObject({
      kind: 'tier',
      tierId: big.id,
      fromTierId: null,
      bump: false,
      currency: 'NGN',
      planMinor: price,
      bumpMinor: 0,
      bumpPoints: 0,
      paymentKind: 'tier',
    });
    expect(q.payment).toMatchObject({
      kind: 'tier',
      priceKobo: price,
      totalKobo: price + liveFee(price),
      balanceKobo: before,
      shortfallKobo: 0,
      willBeHeld: false,
    });

    const res = await call.buy(p, bodyFor({ kind: 'tier', tierId: big.id }, q));
    expect(res.status).toBe(201);
    const view = body<PlanPurchaseView>(res).data!;
    expect(view).toMatchObject({
      kind: 'tier',
      tierId: big.id,
      fromTierId: null,
      bump: false,
      method: 'wallet',
      currency: 'NGN',
      amountMinor: price,
      status: 'paid',
      statusMessage: null,
    });
    expect(view.payment).toMatchObject({
      kind: 'tier',
      status: 'completed',
      delivered: true,
      priceKobo: price,
      totalKobo: price + liveFee(price),
    });

    // One debit at the config price (plus the provider's charge, R-10).
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: price,
      feeKobo: liveFee(price),
    });
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(
      before - price - liveFee(price),
    );
    const payment = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(payment).toMatchObject({
      kind: 'tier',
      payeeWawuUserId: null,
      payeeShareKobo: 0n,
      wawuShareKobo: BigInt(price),
    });
    expect(h.wallets.kobo.get(sendsFrom(p)[0].to)).toBeGreaterThanOrEqual(
      price,
    );

    // GET /me/tier
    const tier = await tierOf(p);
    expect(tier).toMatchObject({
      state: 'active',
      tier: { id: big.id, name: big.name },
      productsAllowed: big.products,
      extraProducts: 0,
      pointsIncluded: big.bonusPoints,
      firstVoiceIntroIncluded: big.firstVoiceIntro,
      eventPass: { id: big.eventPass },
    });
    const from = Date.parse(tier.activeFrom!);
    expect(from).toBeLessThanOrEqual(Date.now());
    expect(from).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(Date.parse(tier.activeUntil!)).toBe(from + big.days * DAY);

    // GET /me/points: one bonus lot with its expiry
    const points = await pointsOf(p);
    expect(points.balance).toBe(big.bonusPoints);
    expect(points.lots).toHaveLength(1);
    expect(points.lots[0]).toMatchObject({
      source: 'tier_bonus',
      granted: big.bonusPoints,
    });
    expect(Date.parse(points.lots[0].expiresAt!)).toBe(
      from + big.bonusExpiryDays * DAY,
    );

    // What the purchase says it gave
    expect(view.grant).toMatchObject({
      tier: { id: big.id },
      activeFrom: tier.activeFrom,
      activeUntil: tier.activeUntil,
      productsAllowed: big.products,
      bonusPoints: big.bonusPoints,
      bumpPoints: 0,
      bumpPointsExpireAt: null,
      eventPass: { id: big.eventPass },
      firstVoiceIntroIncluded: big.firstVoiceIntro,
    });
    expect(view.paidAt).not.toBeNull();

    // The records: one purchase row keyed by the payment, the currency fixed by it, one pass
    const rows = await rowsOf(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentRef: view.id,
      kind: 'tier',
      tierId: big.id,
      fromTierId: null,
      bump: false,
      currency: 'NGN',
      amountMinor: price,
      method: 'wallet',
      status: 'paid',
    });
    expect(
      await h.prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      }),
    ).toMatchObject({
      currency: 'NGN',
      fixedBy: 'first_purchase',
      purchaseRef: view.id,
    });
    expect(
      await h.prisma.eventPass.count({
        where: { wawuUserId: p.id, purchaseRef: view.id },
      }),
    ).toBe(1);

    // The same purchase, read by its id
    const read = await call.read(p, view.id);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(body<PlanPurchaseView>(read).data).toEqual(view);
  });

  it('adds the checkout bump to the same payment: one debit of both prices, its points as a bought lot', async () => {
    const p = await h.buyer(RICH);
    const total = priceIn(small.price, 'NGN') + bumpKobo;
    const { q, view } = await purchase(p, {
      kind: 'tier',
      tierId: small.id,
      bump: true,
    });
    expect(q).toMatchObject({
      paymentKind: 'tier_bump',
      bumpMinor: bumpKobo,
      bumpPoints,
    });
    expect(view).toMatchObject({
      status: 'paid',
      bump: true,
      amountMinor: total,
    });
    expect(view.payment).toMatchObject({
      kind: 'tier_bump',
      priceKobo: total,
      delivered: true,
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0].amountKobo).toBe(total);

    const points = await pointsOf(p);
    expect(points.balance).toBe(small.bonusPoints + bumpPoints);
    expect(points.lots.map((l) => l.source).sort()).toEqual([
      'bump',
      'tier_bonus',
    ]);
    const bump = points.lots.find((l) => l.source === 'bump')!;
    expect(bump.granted).toBe(bumpPoints);
    // Bought points never end (R-101 point 7); this asserted a year's expiry before.
    expect(bump.expiresAt).toBeNull();
    expect(bump.cashable).toBe(false);
    expect(view.grant).toMatchObject({
      bonusPoints: small.bonusPoints,
      bumpPoints,
    });
    expect((await rowsOf(p))[0]).toMatchObject({
      bump: true,
      amountMinor: total,
    });
  });

  it('shows in the wallet history as a purchase named after the tier, with the checkout bump said', async () => {
    const p = await h.buyer(RICH);
    await purchase(p, { kind: 'tier', tierId: small.id, bump: true });
    const res = await request(h.app.getHttpServer())
      .get('/api/hub/money/transactions')
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    const rows = body<TransactionPage>(res).data!.items.filter(
      (r) => r.link?.kind === 'tier_bump',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'out',
      category: 'purchase',
      status: 'completed',
      description: `Tier and points · ${small.name} and bonus points`,
    });
    expect(rows[0].description).not.toMatch(/\u2014/);
  });

  // ---------------------------------------------------------------------------
  // Check 2: once, however often it is asked
  // ---------------------------------------------------------------------------

  it('check 2: the same request twice debits once and grants once; the second answer is the first, replayed, and no PIN is used', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: big.id };
    const q = await quoted(p, t);
    const key = randomUUID();
    const first = await call.buy(p, bodyFor(t, q), { key });
    expect(first.status).toBe(201);
    const second = await call.buy(p, bodyFor(t, q), { key, pin: '0000' });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(body<PlanPurchaseView>(second).data!.grant).not.toBeNull();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rowsOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
    // The wrong PIN on a replay costs no try.
    const pin = await h.prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(pin.failedTries).toBe(0);
    // The same key with another body is not a replay.
    const reused = await call.buy(p, bodyFor(t, q, { bump: true }), { key });
    expect(reused.status).toBe(409);
    expect(reasonOf(reused).code).toBe('idempotency_key_reused');
  });

  it('check 2: two taps at once with one key debit once and grant once', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: big.id };
    const q = await quoted(p, t);
    const key = randomUUID();
    const taps = await Promise.all(
      [1, 2, 3, 4].map(() => call.buy(p, bodyFor(t, q), { key })),
    );
    const ok = taps.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of taps.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(reasonOf(r).code).toBe('idempotency_in_progress');
    }
    for (const r of ok)
      expect(body<PlanPurchaseView>(r).data!.status).toBe('paid');
    expect(
      new Set(ok.map((r) => body<PlanPurchaseView>(r).data!.id)).size,
    ).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rowsOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
    expect(
      await h.prisma.eventPass.count({ where: { wawuUserId: p.id } }),
    ).toBe(1);
  });

  it('check 2: two taps at once under different keys take one payment; the other is told it is going through, or that the plan runs', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: big.id };
    const q = await quoted(p, t);
    const taps = await Promise.all(
      [1, 2, 3].map(() => call.buy(p, bodyFor(t, q), { key: randomUUID() })),
    );
    expect(taps.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of taps.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(['payment_in_progress', 'target_not_payable']).toContain(
        reasonOf(r).code,
      );
    }
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rowsOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
  });

  it('check 2: a confirmation delivered twice, or five at once, grants once', async () => {
    const p = await h.buyer(RICH);
    const { view } = await purchase(p, {
      kind: 'tier',
      tierId: small.id,
      bump: true,
    });
    expect(view.status).toBe('paid');
    const handler = h.registry.get('tier_bump')!;
    const again = {
      paymentId: view.id,
      payerWawuUserId: p.id,
      kind: 'tier_bump' as PaymentKind,
      targetId: view.payment.targetId,
      priceKobo: view.payment.priceKobo,
      payeeWawuUserId: null,
      note: null,
      holdId: null,
    };
    await handler.onCompleted!(again);
    await Promise.all([1, 2, 3, 4, 5].map(() => handler.onCompleted!(again)));
    expect(await rowsOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(2);
    expect(
      await h.prisma.eventPass.count({ where: { wawuUserId: p.id } }),
    ).toBe(1);
    expect((await pointsOf(p)).balance).toBe(small.bonusPoints + bumpPoints);
    expect((await tierOf(p)).activeUntil).toBe(view.grant!.activeUntil);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Check 3: renew and upgrade
  // ---------------------------------------------------------------------------

  it('check 3: an upgrade debits only the difference of the two config prices, grants the difference in bonus points, starts today and keeps the unused points', async () => {
    const p = await h.buyer(RICH);
    const first = (await purchase(p, { kind: 'tier', tierId: small.id })).view;
    expect(first.status).toBe('paid');
    const before = await tierOf(p);
    const lotsBefore = (await pointsOf(p)).lots;
    expect(lotsBefore).toHaveLength(1);
    const walletBefore = h.wallets.kobo.get(p.accountNumber)!;

    const diff = priceIn(big.price, 'NGN') - priceIn(small.price, 'NGN');
    const { q, view } = await purchase(p, { kind: 'upgrade', tierId: big.id });
    expect(q).toMatchObject({
      kind: 'upgrade',
      fromTierId: small.id,
      planMinor: diff,
    });
    expect(view).toMatchObject({
      kind: 'upgrade',
      tierId: big.id,
      fromTierId: small.id,
      status: 'paid',
      amountMinor: diff,
    });
    expect(sendsFrom(p)).toHaveLength(2);
    expect(sendsFrom(p)[1]).toMatchObject({
      amountKobo: diff,
      feeKobo: liveFee(diff),
    });
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(
      walletBefore - diff - liveFee(diff),
    );

    const after = await tierOf(p);
    expect(after).toMatchObject({
      state: 'active',
      tier: { id: big.id },
      productsAllowed: big.products,
      pointsIncluded: big.bonusPoints,
      eventPass: { id: big.eventPass },
    });
    // The new period starts now, never later, and the old end is not carried over.
    const from = Date.parse(after.activeFrom!);
    expect(from).toBeLessThanOrEqual(Date.now());
    expect(from).toBeGreaterThanOrEqual(Date.parse(before.activeFrom!));
    expect(Date.parse(after.activeUntil!)).toBe(from + big.days * DAY);

    // The difference in bonus points, as its own lot with the new tier's expiry; the unused points stay.
    const points = await pointsOf(p);
    expect(points.balance).toBe(big.bonusPoints);
    const lots = await lotsOf(p);
    expect(lots).toHaveLength(2);
    const old = lots.find((l) => l.sourceRef === first.id)!;
    expect(old).toMatchObject({
      remaining: small.bonusPoints,
      quantity: small.bonusPoints,
    });
    const extra = lots.find((l) => l.sourceRef === view.id)!;
    expect(extra.quantity).toBe(big.bonusPoints - small.bonusPoints);
    expect(extra.expiresAt.getTime()).toBe(from + big.bonusExpiryDays * DAY);
    expect(view.grant).toMatchObject({
      bonusPoints: big.bonusPoints - small.bonusPoints,
    });
    expect((await rowsOf(p)).map((r) => r.kind).sort()).toEqual([
      'tier',
      'upgrade',
    ]);
    // The currency was fixed by the first purchase and not touched by the second.
    expect(
      await h.prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      }),
    ).toMatchObject({ purchaseRef: first.id });
  });

  it('renewing the tier held extends from its current end and adds its bonus points again', async () => {
    const p = await h.buyer(RICH);
    const first = (await purchase(p, { kind: 'tier', tierId: small.id })).view;
    const t1 = await tierOf(p);
    const { view } = await purchase(p, { kind: 'renew', tierId: small.id });
    expect(view).toMatchObject({
      kind: 'renew',
      status: 'paid',
      amountMinor: priceIn(small.price, 'NGN'),
    });
    const t2 = await tierOf(p);
    expect(Date.parse(t2.activeUntil!)).toBe(
      Date.parse(t1.activeUntil!) + small.days * DAY,
    );
    expect(t2.activeFrom).toBe(t1.activeFrom);
    expect((await pointsOf(p)).balance).toBe(2 * small.bonusPoints);
    expect((await rowsOf(p)).map((r) => r.paymentRef).sort()).toEqual(
      [first.id, view.id].sort(),
    );
    expect(sendsFrom(p)).toHaveLength(2);
  });

  it('renewing a tier that ended starts it again from now', async () => {
    const p = await h.buyer(RICH);
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId: small.id,
        activeFrom: new Date(Date.now() - 40 * DAY),
        activeUntil: new Date(Date.now() - DAY),
        productsIncluded: small.products,
        pointsIncluded: small.bonusPoints,
        voiceIntroIncluded: false,
      },
    });
    expect((await tierOf(p)).state).toBe('ended');
    const { view } = await purchase(p, { kind: 'renew', tierId: small.id });
    expect(view.status).toBe('paid');
    const t = await tierOf(p);
    expect(t.state).toBe('active');
    expect(Date.parse(t.activeFrom!)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(t.activeFrom!)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(t.activeUntil!)).toBe(
      Date.parse(t.activeFrom!) + small.days * DAY,
    );
  });

  it('refuses what does not fit what the person holds, with the reason in words, and takes nothing', async () => {
    const p = await h.buyer(RICH);
    // nothing held: renew and upgrade
    for (const kind of ['renew', 'upgrade'] as const) {
      const res = await call.quote(p, { kind, tierId: big.id });
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('target_not_payable');
    }
    // a tier the config does not name
    const unknown = await call.quote(p, { kind: 'tier', tierId: 'nope' });
    expect(unknown.status).toBe(404);
    expect(reasonOf(unknown)).toMatchObject({
      code: 'target_not_found',
      message: PLAN_NOT_FOUND_MESSAGE,
    });
    await purchase(p, { kind: 'tier', tierId: big.id });
    const sends = sendsFrom(p).length;
    // running: a first purchase of any tier, and a move to a smaller tier
    const again = await call.quote(p, { kind: 'tier', tierId: small.id });
    expect(again.status).toBe(409);
    expect(reasonOf(again)).toMatchObject({
      code: 'target_not_payable',
      message: PLAN_RUNNING_MESSAGE,
    });
    const down = await call.quote(p, { kind: 'upgrade', tierId: small.id });
    expect(down.status).toBe(409);
    expect(reasonOf(down)).toMatchObject({
      code: 'target_not_payable',
      message: NO_DOWNGRADE_MESSAGE,
    });
    const other = await call.quote(p, { kind: 'renew', tierId: small.id });
    expect(other.status).toBe(409);
    const bad = await call.buy(p, {
      kind: 'tier',
      tierId: small.id,
      method: 'wallet',
      expectedTotalKobo: 1,
      quoteToken: 'x',
    });
    expect(bad.status).toBe(409);
    expect(reasonOf(bad).code).toBe('target_not_payable');
    expect(sendsFrom(p)).toHaveLength(sends);
    expect(await rowsOf(p)).toHaveLength(1);
  });

  it('an upgrade quoted from one tier is not paid once the person runs another: the quote no longer fits and nothing is taken', async () => {
    const p = await h.buyer(RICH);
    await purchase(p, { kind: 'tier', tierId: small.id });
    const t: Terms = { kind: 'upgrade', tierId: big.id };
    const q = await quoted(p, t);
    expect(q.fromTierId).toBe(small.id);
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: { tierId: middle.id },
    });
    const sends = sendsFrom(p).length;
    const res = await call.buy(p, bodyFor(t, q));
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(sends);
    expect(await rowsOf(p)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Check 4: short of money, still confirming, failed
  // ---------------------------------------------------------------------------

  it('check 4: a person short of money gets the exact shortfall and nothing is granted; the same key pays once after the top-up', async () => {
    const price = priceIn(big.price, 'NGN');
    const have = price - 123_456;
    const p = await h.buyer(have);
    const t: Terms = { kind: 'tier', tierId: big.id };
    const q = await quoted(p, t);
    expect(q.payment).toMatchObject({
      balanceKobo: have,
      shortfallKobo: price + liveFee(price) - have,
    });
    const key = randomUUID();
    const res = await call.buy(p, bodyFor(t, q), { key });
    expect(res.status).toBe(402);
    expect(reasonOf(res)).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: have,
      totalKobo: price + liveFee(price),
      shortfallKobo: price + liveFee(price) - have,
    });
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await rowsOf(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
    expect((await tierOf(p)).state).toBe('none');
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);

    h.wallets.kobo.set(p.accountNumber, price + liveFee(price));
    const again = await call.buy(p, bodyFor(t, q), { key });
    expect(again.status).toBe(201);
    expect(body<PlanPurchaseView>(again).data!.status).toBe('paid');
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('check 4: a payment still confirming grants nothing, tells the person not to pay again, and grants once when it confirms', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: big.id, bump: true };
    const q = await quoted(p, t);
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, bodyFor(t, q));
    h.wallets.mode = 'live';
    expect(res.status).toBe(201);
    const pending = body<PlanPurchaseView>(res).data!;
    expect(pending).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      grant: null,
      paidAt: null,
    });
    expect(pending.payment).toMatchObject({
      status: 'pending',
      delivered: false,
    });
    expect((await tierOf(p)).state).toBe('none');
    expect((await pointsOf(p)).balance).toBe(0);
    expect(await rowsOf(p)).toHaveLength(0);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);

    // A second tap, under another key or for another plan, is not taken.
    const second = await call.buy(p, bodyFor(t, q), { key: randomUUID() });
    expect(second.status).toBe(409);
    expect(reasonOf(second)).toMatchObject({
      code: 'payment_in_progress',
      paymentId: pending.id,
    });
    const other = await call.quote(p, { kind: 'tier', tierId: small.id });
    expect(other.status).toBe(409);
    expect(reasonOf(other)).toMatchObject({
      code: 'payment_in_progress',
      paymentId: pending.id,
    });
    expect(sendsFrom(p)).toHaveLength(1);

    // Its record lags: still pending, and the poll says so.
    h.wallets.hidden.add(pending.payment.reference);
    await h.sweepLater();
    expect(
      body<PlanPurchaseView>(await call.read(p, pending.id)).data,
    ).toMatchObject({
      status: 'pending',
      grant: null,
    });
    expect((await tierOf(p)).state).toBe('none');

    // It confirms: granted once.
    h.wallets.hidden.delete(pending.payment.reference);
    await h.sweepLater();
    await h.sweepLater();
    const paid = body<PlanPurchaseView>(await call.read(p, pending.id)).data!;
    expect(paid).toMatchObject({ status: 'paid', statusMessage: null });
    expect(paid.payment).toMatchObject({
      status: 'completed',
      delivered: true,
    });
    expect(paid.grant).toMatchObject({
      bonusPoints: big.bonusPoints,
      bumpPoints,
    });
    expect((await tierOf(p)).state).toBe('active');
    expect((await pointsOf(p)).balance).toBe(big.bonusPoints + bumpPoints);
    expect(await rowsOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(2);
    expect(sendsFrom(p)).toHaveLength(1);
    // The key's replay is the first answer as stored: pending (the answer is a record of that moment).
    expect(body<PlanPurchaseView>(res).data!.status).toBe('pending');
  });

  it('check 4: a failed payment grants nothing, says why, and the person can pay again', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: big.id };
    const q = await quoted(p, t);
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, bodyFor(t, q));
    h.wallets.mode = 'live';
    const pending = body<PlanPurchaseView>(res).data!;
    expect(pending.status).toBe('pending');
    h.wallets.failures.add(pending.payment.reference);
    await h.sweepLater();
    const failed = body<PlanPurchaseView>(await call.read(p, pending.id)).data!;
    expect(failed).toMatchObject({
      status: 'failed',
      statusMessage: PAYMENT_FAILED_REASON,
      grant: null,
      paidAt: null,
    });
    expect(failed.payment).toMatchObject({
      status: 'failed',
      delivered: false,
    });
    expect((await tierOf(p)).state).toBe('none');
    expect((await pointsOf(p)).balance).toBe(0);
    expect(await rowsOf(p)).toHaveLength(0);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);

    // The item is free again: a new intent pays and grants.
    h.wallets.kobo.set(p.accountNumber, RICH);
    const { view } = await purchase(p, t);
    expect(view.status).toBe('paid');
    expect(await rowsOf(p)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Check 5: the currency
  // ---------------------------------------------------------------------------

  it('check 5: the first purchase fixes the billing currency (naira, from a naira wallet) and the second leaves it', async () => {
    const p = await h.buyer(RICH);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    const first = (await purchase(p, { kind: 'tier', tierId: small.id })).view;
    const fixed = await h.prisma.personBilling.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(fixed).toMatchObject({
      currency: 'NGN',
      fixedBy: 'first_purchase',
      purchaseRef: first.id,
    });
    await purchase(p, { kind: 'renew', tierId: small.id });
    expect(
      await h.prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      }),
    ).toEqual(fixed);
  });

  it('check 5: a person billed in dollars is not charged cents as kobo: the naira wallet refuses it and nothing moves', async () => {
    const p = await h.buyer(RICH);
    await h.prisma.personBilling.create({
      data: { wawuUserId: p.id, currency: 'USD', fixedBy: 'support' },
    });
    const quote = await call.quote(p, { kind: 'tier', tierId: small.id });
    expect(quote.status).toBe(409);
    expect(reasonOf(quote)).toMatchObject({
      code: 'target_not_payable',
      message: OTHER_CURRENCY_MESSAGE,
    });
    const res = await call.buy(p, {
      kind: 'tier',
      tierId: small.id,
      method: 'wallet',
      expectedTotalKobo: 100,
      quoteToken: 'x',
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('target_not_payable');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await rowsOf(p)).toHaveLength(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Check 6: no wallet, and the PIN
  // ---------------------------------------------------------------------------

  it('check 6: a person without a wallet gets wallet_not_open on the quote and the purchase, whatever was sent, and no key is kept', async () => {
    const p = await h.walletless();
    const quote = await call.quote(p, { kind: 'tier', tierId: small.id });
    expect(quote.status).toBe(409);
    expect(reasonOf(quote).code).toBe('wallet_not_open');
    const key = randomUUID();
    const res = await call.buy(
      p,
      {
        kind: 'tier',
        tierId: small.id,
        method: 'wallet',
        expectedTotalKobo: 100,
        quoteToken: 'x',
      },
      { key, pin: null },
    );
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('wallet_not_open');
    expect(
      await h.prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(await rowsOf(p)).toHaveLength(0);
  });

  it('check 6: five wrong PINs lock the PIN as MONEY-09 does, even for the right PIN after; nothing is taken or granted', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const q = await quoted(p, t);
    // As MONEY-09 does: four wrong tries are 403 with the tries left, the fifth locks (423).
    for (const left of [4, 3, 2, 1]) {
      const res = await call.buy(p, bodyFor(t, q), { pin: '1111' });
      expect(res.status).toBe(403);
      expect(reasonOf(res)).toMatchObject({
        code: 'pin_incorrect',
        triesLeft: left,
      });
    }
    const fifth = await call.buy(p, bodyFor(t, q), { pin: '1111' });
    expect(fifth.status).toBe(423);
    expect(reasonOf(fifth).code).toBe('pin_locked');
    const locked = await call.buy(p, bodyFor(t, q), { pin: PIN });
    expect(locked.status).toBe(423);
    expect(reasonOf(locked).code).toBe('pin_locked');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await rowsOf(p)).toHaveLength(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it('a missing Idempotency-Key, PIN or quote is refused before anything is taken', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const q = await quoted(p, t);
    const noKey = await call.buy(p, bodyFor(t, q), { key: '' });
    expect(noKey.status).toBe(400);
    expect(reasonOf(noKey).code).toBe('idempotency_key_required');
    const noPin = await call.buy(p, bodyFor(t, q), { pin: null });
    expect(noPin.status).toBe(403);
    expect(reasonOf(noPin).code).toBe('pin_required');
    const staleTotal = await call.buy(
      p,
      bodyFor(t, q, { expectedTotalKobo: q.payment.totalKobo + 1 }),
    );
    expect(staleTotal.status).toBe(409);
    expect(reasonOf(staleTotal).code).toBe('quote_changed');
    const wrongToken = await call.buy(
      p,
      bodyFor(t, q, { quoteToken: 'abc.def' }),
    );
    expect(wrongToken.status).toBe(409);
    expect(reasonOf(wrongToken).code).toBe('quote_changed');
    // A quote for another plan is not this plan's.
    const other = await quoted(p, { kind: 'tier', tierId: big.id });
    const swapped = await call.buy(p, bodyFor(t, other));
    expect(swapped.status).toBe(409);
    expect(reasonOf(swapped).code).toBe('quote_changed');
    const method = await call.buy(p, bodyFor(t, q, { method: 'card' }));
    expect(method.status).toBe(400);
    const unknownField = await call.buy(p, bodyFor(t, q, { price: 1 }));
    expect(unknownField.status).toBe(400);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  it('the quote refuses a malformed ask as a plain 400 and takes nothing', async () => {
    const p = await h.buyer(RICH);
    const ask = (qs: string) =>
      request(h.app.getHttpServer())
        .get(`/api/hub/plans/purchases/quote?${qs}`)
        .set('Authorization', p.auth);
    for (const qs of [
      `kind=tier`,
      `tierId=${small.id}`,
      `kind=bogus&tierId=${small.id}`,
      `kind=tier&tierId=${small.id}&bump=banana`,
      `kind=tier&tierId=${small.id}&bump=1`,
      `kind=tier&tierId=Founding`,
      `kind=tier&tierId=${small.id}&price=1`,
    ])
      expect({ qs, status: (await ask(qs)).status }).toEqual({
        qs,
        status: 400,
      });
    expect((await ask(`kind=tier&tierId=${small.id}&bump=true`)).status).toBe(
      200,
    );
    expect((await ask(`kind=tier&tierId=${small.id}&bump=false`)).status).toBe(
      200,
    );
    expect(sendsFrom(p)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Who may read a purchase
  // ---------------------------------------------------------------------------

  it('only the buyer reads a purchase; another person, a payment of another kind and a bad id are refused', async () => {
    const p = await h.buyer(RICH);
    const stranger = await h.buyer(RICH);
    const { view } = await purchase(p, { kind: 'tier', tierId: small.id });
    const theirs = await call.read(stranger, view.id);
    expect(theirs.status).toBe(404);
    expect(reasonOf(theirs).code).toBe('not_found');
    expect((await call.read(p, randomUUID())).status).toBe(404);
    expect((await call.read(p, 'quote')).status).toBe(400);
    expect((await call.read(p, 'not-a-uuid')).status).toBe(400);
    const anon = await call.read({ ...p, auth: 'Bearer nope' }, view.id);
    expect(anon.status).toBe(401);
    // a payment of another kind is not a purchase
    const other = await h.prisma.walletPayment.create({
      data: {
        payerWawuUserId: p.id,
        kind: 'content_unlock',
        targetId: 'x',
        title: 'x',
        priceKobo: 1n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 1n,
        payeeShareKobo: 0n,
        wawuShareKobo: 1n,
        customerReference: `wawu-pay-${randomUUID()}`,
        merchantAccountNumber: '1',
        status: 'completed',
      },
    });
    expect((await call.read(p, other.id)).status).toBe(404);
    expect(tierById(config, small.id)).not.toBeNull();
  });
});
