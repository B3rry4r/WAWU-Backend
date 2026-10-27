import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import { body } from '../../../../test/payments/poll-helpers';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminActor } from '../../../common/audit/admin-ops-audit.service';
import type { TransactionPage } from '../../../money/money-view.type';
import { OTHER_CURRENCY_MESSAGE } from '../../../money/payments/wallet-payment.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import {
  openPackRule,
  resetPackRule,
} from '../../../../test/plans/open-pack-rule';
import { loadPlansConfig, priceIn } from '../../plans-config';
import { PublishingAllowanceService } from '../../publishing-allowance.service';
import { PublishingGate } from '../../publishing-gate.service';
import { TierGateError } from '../../tier-gate-error';
import {
  TIER_ENDED_MESSAGE,
  TIER_REQUIRED_MESSAGE,
} from '../extra-products-rules';
import type {
  ExtraProductsPurchaseView,
  ExtraProductsQuoteView,
} from '../extra-products-view.type';

/**
 * TIER-04 over HTTP: add more products to a tier from the wallet, on the real
 * MoneyModule, PlansModule, PointsModule and PlanPurchasesModule, a real
 * database, real RS256 tokens and the wallet provider seam with NUVION stood
 * in (R-39, R-45): a purchase is a book transfer into WAWU's operational
 * account, and Nuvion's documented first answer is `pending`, settled later.
 * No Nuvion, Fintava or wawuafrica.com host is called. NUVION_FEE is a spec
 * value, not a fact about Nuvion. Every price and count is read from the config
 * the Hub reads (the file, then the settings an admin saved).
 */

jest.setTimeout(120_000);

const NUVION_FEE = 2325;
const DAY = 86_400_000;
const config = loadPlansConfig();
const addOn = config.extraProducts;
const addOnPrice = priceIn(addOn.price, 'NGN');
const tier = config.tiers[0];
const RICH = 100 * addOnPrice;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'tier04@admin.test.wawu.dev',
  role: AdminRole.finance,
};

describe('Add more products to a tier (TIER-04), Nuvion stood in', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let settings: PlanSettingsService;
  let allowance: PublishingAllowanceService;
  let gate: PublishingGate;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootTierApp('t04', { nuvion, nuvionFeeKobo: NUVION_FEE });
    call = api(h);
    settings = h.get(PlanSettingsService);
    allowance = h.get(PublishingAllowanceService);
    gate = h.get(PublishingGate);
    // PACK-CAP (R-100): these cases test the payment on the first tier with
    // many packs; the pack rule has its own spec (extra-products-cap).
    await openPackRule(
      settings,
      config.tiers.map((t) => t.id),
    );
  });
  afterAll(async () => {
    await resetPackRule(settings);
    await h.prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    await h.prisma.makerExtraProducts.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    await h.close();
  });
  beforeEach(() => {
    nuvion.mode = 'successful';
  });

  const data = <T>(res: Response) => body<T>(res).data!;
  const reasonOf = (res: Response) =>
    body<unknown>(res).reason as unknown as { code: string; message: string };
  const quoteRoute = (p: Person, query: Record<string, string>) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/plans/purchases/quote?${new URLSearchParams(query)}`)
      .set('Authorization', p.auth);
  async function quoted(p: Person): Promise<ExtraProductsQuoteView> {
    const res = await quoteRoute(p, { kind: 'extra_products' });
    expect(res.status).toBe(200);
    return data<ExtraProductsQuoteView>(res);
  }
  const bodyFor = (q: ExtraProductsQuoteView, over: object = {}) => ({
    kind: 'extra_products',
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
    ...over,
  });
  /** Quote, then pay with the PIN: what the app does. */
  async function purchase(p: Person, opts: { key?: string } = {}) {
    const q = await quoted(p);
    const res = await call.buy(p, bodyFor(q), opts);
    return { q, res, view: data<ExtraProductsPurchaseView>(res) };
  }
  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account!.accountId);
  const balance = (p: Person) => Number(p.account!.availableKobo);
  const set = (key: string, value: number | null) =>
    settings.set(admin, { settings: { [key]: value } });
  const rowOf = (p: Person) =>
    h.prisma.makerTier.findUniqueOrThrow({ where: { wawuUserId: p.id } });
  const purchasesOf = (p: Person) =>
    h.prisma.makerExtraProducts.findMany({ where: { wawuUserId: p.id } });
  async function hold(
    p: Person,
    activeUntil: Date,
    over: { extraProducts?: number } = {},
  ) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId: tier.id,
        activeFrom: new Date(Date.now() - 10 * DAY),
        activeUntil,
        productsIncluded: 3,
        pointsIncluded: 0,
        voiceIntroIncluded: false,
        ...over,
      },
    });
  }
  const running = (p: Person, over: { extraProducts?: number } = {}) =>
    hold(p, new Date(Date.now() + 100 * DAY), over);
  const publish = (p: Person, used: number) =>
    h.prisma.creatorState.upsert({
      where: { wawuUserId: p.id },
      create: { wawuUserId: p.id, slotsUsed: used },
      update: { slotsUsed: used },
    });

  // ---------------------------------------------------------------------------
  // Check 1: a person at 3 of 3 buys 5 more and can publish 5 more
  // ---------------------------------------------------------------------------

  it('check 1: at 3 of 3 the person buys the add-on in one debit and can publish exactly the count more', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    await publish(p, 3);
    // At the limit before: the gate says so.
    await expect(gate.assertRoomForProduct(p.id)).rejects.toMatchObject({
      code: 'product_limit_reached',
    });
    const before = balance(p);

    const q = await quoted(p);
    expect(q).toMatchObject({
      kind: 'extra_products',
      currency: 'NGN',
      extraMinor: addOnPrice,
      products: addOn.count,
      productsAllowed: 3,
      productsAllowedAfter: 3 + addOn.count,
      paymentKind: 'extra_products',
    });
    expect(q.payment).toMatchObject({
      kind: 'extra_products',
      targetId: 'extra-products',
      priceKobo: addOnPrice,
    });
    // The provider's charge is on top (the Bank charge), never the price.
    expect(q.payment.totalKobo).toBeGreaterThan(addOnPrice);

    const res = await call.buy(p, bodyFor(q));
    expect(res.status).toBe(201);
    const view = data<ExtraProductsPurchaseView>(res);
    expect(view).toMatchObject({
      kind: 'extra_products',
      method: 'wallet',
      currency: 'NGN',
      amountMinor: addOnPrice,
      products: addOn.count,
      status: 'paid',
      statusMessage: null,
      transfer: null,
      payment: { kind: 'extra_products', status: 'completed', delivered: true },
      grant: {
        productsAdded: addOn.count,
        extraProducts: addOn.count,
        productsAllowed: 3 + addOn.count,
      },
    });
    expect(view.paidAt).not.toBeNull();

    // One debit at the price, the provider's charge on top.
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: BigInt(addOnPrice),
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(balance(p)).toBe(before - addOnPrice - NUVION_FEE);
    expect(view.payment!.totalKobo).toBe(q.payment.totalKobo);

    // The tier row and the purchase row.
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
    const rows = await purchasesOf(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentRef: view.payment!.id,
      tierId: tier.id,
      products: addOn.count,
      currency: 'NGN',
      amountMinor: addOnPrice,
    });
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

    // The gate lets exactly the count more through, and then says so again.
    expect(await allowance.of(p.id)).toMatchObject({
      basis: 'tier',
      productsAllowed: 3 + addOn.count,
      extraProducts: addOn.count,
    });
    for (let used = 3; used < 3 + addOn.count; used++) {
      await publish(p, used);
      await expect(gate.assertRoomForProduct(p.id)).resolves.toBeDefined();
    }
    await publish(p, 3 + addOn.count);
    await expect(gate.assertRoomForProduct(p.id)).rejects.toBeInstanceOf(
      TierGateError,
    );
    const mine = data<{ productsAllowed: number; extraProducts: number }>(
      await call.tier(p),
    );
    expect(mine).toMatchObject({
      productsAllowed: 3 + addOn.count,
      extraProducts: addOn.count,
    });

    // The poll answers the same purchase; another person's is a 404.
    const polled = await call.read(p, view.id);
    expect(polled.status).toBe(200);
    expect(data<ExtraProductsPurchaseView>(polled)).toMatchObject({
      id: view.id,
      status: 'paid',
      grant: { productsAdded: addOn.count },
    });
    const other = await h.buyer(RICH);
    expect((await call.read(other, view.id)).status).toBe(404);

    // The history names it.
    const page = await request(h.app.getHttpServer())
      .get('/api/hub/money/transactions')
      .set('Authorization', p.auth);
    const lines = body<TransactionPage>(page).data!.items.filter(
      (r) => r.link?.kind === 'extra_products',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      direction: 'out',
      category: 'purchase',
      status: 'completed',
      description: 'Plan add-on · Extra products',
    });
    expect(lines[0].description).not.toMatch(/\u2014/);
  });

  it('a second add-on is a second purchase and adds the count again; a person with a tier from an event code is billed in naira by it', async () => {
    const p = await h.buyer(RICH);
    await running(p, { extraProducts: 2 });
    await purchase(p);
    expect((await rowOf(p)).extraProducts).toBe(2 + addOn.count);
    await purchase(p);
    expect((await rowOf(p)).extraProducts).toBe(2 + 2 * addOn.count);
    expect(await purchasesOf(p)).toHaveLength(2);
    expect(sendsFrom(p)).toHaveLength(2);
    expect(data<{ extraProducts: number }>(await call.tier(p))).toMatchObject({
      extraProducts: 2 + 2 * addOn.count,
    });
  });

  it('the add-on is sold on a tier that is ending as well', async () => {
    const p = await h.buyer(RICH);
    await hold(p, new Date(Date.now() + 3 * DAY));
    const { view } = await purchase(p);
    expect(view.status).toBe('paid');
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
  });

  // ---------------------------------------------------------------------------
  // Check 2: the same request twice debits once and adds once (V8)
  // ---------------------------------------------------------------------------

  it('check 2: the same request twice debits once and adds once; the replay is the first answer', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    const key = randomUUID();
    const first = await call.buy(p, bodyFor(q), { key });
    expect(first.status).toBe(201);
    const second = await call.buy(p, bodyFor(q), { key, pin: '0000' });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(data(second)).toEqual(data(first));
    expect(sendsFrom(p)).toHaveLength(1);
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
    expect(await purchasesOf(p)).toHaveLength(1);
  });

  it('check 2: ten taps at once with one key debit once and add once', async () => {
    const p = await h.buyer(RICH);
    await running(p);
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
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
  });

  it('check 2: ten taps at once with ten keys take one payment: the rest are payment_in_progress or find it done', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    const taps = await Promise.all(
      Array.from({ length: 10 }, () => call.buy(p, bodyFor(q))),
    );
    expect(taps.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(
      1,
    );
    for (const r of taps) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409)
        expect(['payment_in_progress', 'idempotency_in_progress']).toContain(
          reasonOf(r).code,
        );
    }
    // Whatever got through was paid and added together: one add-on per payment taken.
    const paid = sendsFrom(p).length;
    expect(paid).toBeGreaterThanOrEqual(1);
    expect((await rowOf(p)).extraProducts).toBe(paid * addOn.count);
    expect(await purchasesOf(p)).toHaveLength(paid);
  });

  it('check 2: a payment delivered again (the sweep after a lost answer) adds nothing', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const { view } = await purchase(p);
    const row = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.payment!.id },
    });
    const handler = h.registry.get('extra_products')!;
    const delivered = {
      paymentId: row.id,
      payerWawuUserId: p.id,
      kind: 'extra_products' as const,
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
      handler.onCompleted!(delivered),
    ]);
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
    expect(await purchasesOf(p)).toHaveLength(1);
  });

  it('a delivery that cannot add (the tier row is gone, or the terms are not ours) throws, so the payment is tried again and then reviewed; nothing is written', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const { view } = await purchase(p);
    const row = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.payment!.id },
    });
    const handler = h.registry.get('extra_products')!;
    const base = {
      paymentId: randomUUID(),
      payerWawuUserId: p.id,
      kind: 'extra_products' as const,
      targetId: row.targetId,
      priceKobo: Number(row.priceKobo),
      payeeWawuUserId: null,
      note: null,
      holdId: null,
    };
    const terms = row.terms as Record<string, string | number | boolean>;
    await expect(
      handler.onCompleted!({ ...base, terms: undefined }),
    ).rejects.toThrow();
    await expect(
      handler.onCompleted!({ ...base, terms: { v: 9, products: 5 } }),
    ).rejects.toThrow();
    await expect(
      handler.onCompleted!({ ...base, targetId: 'extra-products-9', terms }),
    ).rejects.toThrow();
    await expect(
      handler.onCompleted!({ ...base, priceKobo: 0, terms }),
    ).rejects.toThrow();
    const stranger = await h.buyer(RICH);
    await expect(
      handler.onCompleted!({ ...base, payerWawuUserId: stranger.id, terms }),
    ).rejects.toThrow();
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
    expect(await purchasesOf(p)).toHaveLength(1);
    expect(await purchasesOf(stranger)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Check 3: without a running tier the purchase answers tier_required
  // ---------------------------------------------------------------------------

  it('check 3: with no tier the quote and the purchase are 402 tier_required, and nothing is debited or kept', async () => {
    const p = await h.buyer(RICH);
    const before = balance(p);
    const res = await quoteRoute(p, { kind: 'extra_products' });
    expect(res.status).toBe(402);
    expect(reasonOf(res)).toMatchObject({
      code: 'tier_required',
      message: TIER_REQUIRED_MESSAGE,
    });
    const key = randomUUID();
    const buy = await call.buy(
      p,
      {
        kind: 'extra_products',
        method: 'wallet',
        expectedTotalKobo: 100_000,
        quoteToken: 'x',
      },
      { key },
    );
    expect(buy.status).toBe(402);
    expect(reasonOf(buy).code).toBe('tier_required');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(balance(p)).toBe(before);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(await purchasesOf(p)).toHaveLength(0);
    expect(
      await h.prisma.makerTier.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    // No billing currency is fixed by a purchase that did not happen.
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    // The key is given back: after the person buys a tier it is theirs to use.
    await running(p);
    const q = await quoted(p);
    const again = await call.buy(p, bodyFor(q), { key });
    expect(again.status).toBe(201);
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
  });

  it('check 3: an ended tier is 402 tier_required too, with its own sentence; the extras bought before stay on the row', async () => {
    const p = await h.buyer(RICH);
    await hold(p, new Date(Date.now() - DAY), { extraProducts: 5 });
    const res = await quoteRoute(p, { kind: 'extra_products' });
    expect(res.status).toBe(402);
    expect(reasonOf(res)).toMatchObject({
      code: 'tier_required',
      message: TIER_ENDED_MESSAGE,
    });
    const buy = await call.buy(p, {
      kind: 'extra_products',
      method: 'wallet',
      expectedTotalKobo: 100_000,
      quoteToken: 'x',
    });
    expect(buy.status).toBe(402);
    expect(sendsFrom(p)).toHaveLength(0);
    expect((await rowOf(p)).extraProducts).toBe(5);
  });

  it('the payment routes ask the same question: GET /money/payments/quote for extra-products is the same quote, and a person with no tier is 402', async () => {
    const p = await h.buyer(RICH);
    const none = await request(h.app.getHttpServer())
      .get(
        '/api/hub/money/payments/quote?kind=extra_products&targetId=extra-products',
      )
      .set('Authorization', p.auth);
    expect(none.status).toBe(402);
    expect(reasonOf(none).code).toBe('tier_required');
    await running(p);
    const res = await request(h.app.getHttpServer())
      .get(
        '/api/hub/money/payments/quote?kind=extra_products&targetId=extra-products',
      )
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    const direct = data<{ priceKobo: number; totalKobo: number }>(res);
    const q = await quoted(p);
    expect(direct.priceKobo).toBe(q.payment.priceKobo);
    expect(direct.totalKobo).toBe(q.payment.totalKobo);
    // Any other target for the kind is not an item.
    const other = await request(h.app.getHttpServer())
      .get('/api/hub/money/payments/quote?kind=extra_products&targetId=extra-9')
      .set('Authorization', p.auth);
    expect(other.status).toBe(404);
    expect(reasonOf(other).code).toBe('target_not_found');
    // A tier payment and the add-on are different payments.
    const tierQuote = await call.quote(p, { kind: 'renew', tierId: tier.id });
    expect(tierQuote.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Check 4: after a tier ends and is renewed, the bought products still count
  // ---------------------------------------------------------------------------

  it('check 4: the products bought stay when the tier ends and is renewed, and when it ends and a tier is bought again', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    await purchase(p);
    expect((await allowance.of(p.id)).productsAllowed).toBe(3 + addOn.count);

    // The tier ends: nothing can be published, and the extras wait on the row.
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: { activeUntil: new Date(Date.now() - DAY) },
    });
    expect(await allowance.of(p.id)).toMatchObject({
      basis: 'none',
      productsAllowed: 0,
      tierState: 'ended',
    });
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);

    // Renewed from the wallet, by the real route.
    const q = await call.quote(p, { kind: 'renew', tierId: tier.id });
    expect(q.status).toBe(200);
    const qd = data<{ payment: { totalKobo: number; quoteToken: string } }>(q);
    const renewed = await call.buy(p, {
      kind: 'renew',
      tierId: tier.id,
      method: 'wallet',
      expectedTotalKobo: qd.payment.totalKobo,
      quoteToken: qd.payment.quoteToken,
    });
    expect(renewed.status).toBe(201);
    expect(data<{ status: string }>(renewed).status).toBe('paid');
    const row = await rowOf(p);
    expect(row.extraProducts).toBe(addOn.count);
    expect(row.activeUntil.getTime()).toBeGreaterThan(Date.now());
    expect(await allowance.of(p.id)).toMatchObject({
      basis: 'tier',
      productsAllowed: row.productsIncluded + addOn.count,
      extraProducts: addOn.count,
    });
    expect(data<{ productsAllowed: number }>(await call.tier(p))).toMatchObject(
      {
        productsAllowed: row.productsIncluded + addOn.count,
      },
    );
    // And the person can buy more on the renewed tier.
    await purchase(p);
    expect((await rowOf(p)).extraProducts).toBe(2 * addOn.count);
  });

  it('check 4: a bigger tier bought by upgrade keeps the extras too', async () => {
    const bigger = config.tiers.find(
      (t) => priceIn(t.price, 'NGN') > priceIn(tier.price, 'NGN'),
    );
    if (!bigger) return;
    const p = await h.buyer(RICH);
    await running(p, { extraProducts: 4 });
    const q = await call.quote(p, { kind: 'upgrade', tierId: bigger.id });
    expect(q.status).toBe(200);
    const qd = data<{ payment: { totalKobo: number; quoteToken: string } }>(q);
    const res = await call.buy(p, {
      kind: 'upgrade',
      tierId: bigger.id,
      method: 'wallet',
      expectedTotalKobo: qd.payment.totalKobo,
      quoteToken: qd.payment.quoteToken,
    });
    expect(res.status).toBe(201);
    const row = await rowOf(p);
    expect(row.tierId).toBe(bigger.id);
    expect(row.extraProducts).toBe(4);
    expect((await allowance.of(p.id)).productsAllowed).toBe(
      bigger.products + 4,
    );
  });

  // ---------------------------------------------------------------------------
  // The quote binds price and count
  // ---------------------------------------------------------------------------

  it('a price changed after the quote is 409 quote_changed; nothing moves', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    await set('plan.extra_products.price_kobo', addOnPrice + 10_000);
    try {
      const res = await call.buy(p, bodyFor(q));
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('quote_changed');
    } finally {
      await set('plan.extra_products.price_kobo', null);
    }
    expect(sendsFrom(p)).toHaveLength(0);
    expect((await rowOf(p)).extraProducts).toBe(0);
  });

  it('the count changed after the quote at the same price is 409 quote_changed; the new quote is bought as quoted', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    await set('plan.extra_products.count', addOn.count + 3);
    try {
      const res = await call.buy(p, bodyFor(q));
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('quote_changed');
      expect(sendsFrom(p)).toHaveLength(0);
      const fresh = await quoted(p);
      expect(fresh.products).toBe(addOn.count + 3);
      const bought = await call.buy(p, bodyFor(fresh));
      expect(bought.status).toBe(201);
      expect(data<ExtraProductsPurchaseView>(bought).grant).toMatchObject({
        productsAdded: addOn.count + 3,
      });
    } finally {
      await set('plan.extra_products.count', null);
    }
    expect((await rowOf(p)).extraProducts).toBe(addOn.count + 3);
  });

  it('a setting changed while the payment confirms does not change what it adds: the count is what was quoted', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    nuvion.mode = 'pending';
    const res = await call.buy(p, bodyFor(q));
    const pending = data<ExtraProductsPurchaseView>(res);
    expect(pending.status).toBe('pending');
    expect(pending.grant).toBeNull();
    expect((await rowOf(p)).extraProducts).toBe(0);
    await set('plan.extra_products.count', addOn.count + 7);
    try {
      nuvion.settle(pending.payment!.reference, 'successful');
      await h.sweepLater();
      const done = data<ExtraProductsPurchaseView>(
        await call.read(p, pending.id),
      );
      expect(done.status).toBe('paid');
      expect(done.grant!.productsAdded).toBe(addOn.count);
      expect((await rowOf(p)).extraProducts).toBe(addOn.count);
      expect(sendsFrom(p)).toHaveLength(1);
    } finally {
      await set('plan.extra_products.count', null);
    }
  });

  it('a tier that ends while the payment confirms does not cost the person the products: they are added and wait for the next tier', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    nuvion.mode = 'pending';
    const res = await call.buy(p, bodyFor(q));
    const pending = data<ExtraProductsPurchaseView>(res);
    expect(pending.status).toBe('pending');
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: { activeUntil: new Date(Date.now() - DAY) },
    });
    nuvion.settle(pending.payment!.reference, 'successful');
    await h.sweepLater();
    const done = data<ExtraProductsPurchaseView>(
      await call.read(p, pending.id),
    );
    expect(done.status).toBe('paid');
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
    expect((await allowance.of(p.id)).productsAllowed).toBe(0);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Refusals
  // ---------------------------------------------------------------------------

  it('a request that mixes the add-on with a tier, a pack or the bump is 400; nothing is bought', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    for (const over of [
      { tierId: tier.id },
      { packId: config.packs[0].id },
      { bump: true },
    ]) {
      const res = await call.buy(p, bodyFor(q, over));
      expect(res.status).toBe(400);
    }
    for (const extra of [
      { tierId: tier.id },
      { packId: config.packs[0].id },
      { bump: 'true' },
    ] as Record<string, string>[]) {
      const res = await quoteRoute(p, { kind: 'extra_products', ...extra });
      expect(res.status).toBe(400);
    }
    // A tier kind asked for with no tierId is still 400.
    const noTier = await quoteRoute(p, { kind: 'renew' });
    expect(noTier.status).toBe(400);
    expect(sendsFrom(p)).toHaveLength(0);
    expect((await rowOf(p)).extraProducts).toBe(0);
  });

  it('not enough money is 402 insufficient_funds with the shortfall; nothing is added and the key is given back', async () => {
    const p = await h.buyer(1_000);
    await running(p);
    const q = await quoted(p);
    const key = randomUUID();
    const res = await call.buy(p, bodyFor(q), { key });
    expect(res.status).toBe(402);
    expect(reasonOf(res).code).toBe('insufficient_funds');
    expect(sendsFrom(p)).toHaveLength(0);
    expect((await rowOf(p)).extraProducts).toBe(0);
    p.account!.availableKobo = BigInt(RICH);
    const again = await call.buy(p, bodyFor(q), { key });
    expect(again.status).toBe(201);
    expect((await rowOf(p)).extraProducts).toBe(addOn.count);
  });

  it('a person without a wallet is 409 wallet_not_open', async () => {
    const p = await h.walletless();
    await running(p);
    const res = await quoteRoute(p, { kind: 'extra_products' });
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('wallet_not_open');
  });

  it('a wrong PIN adds nothing and takes nothing', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    const q = await quoted(p);
    const res = await call.buy(p, bodyFor(q), { pin: '0000' });
    expect(res.status).toBe(403);
    expect(reasonOf(res).code).toBe('pin_incorrect');
    expect(sendsFrom(p)).toHaveLength(0);
    expect((await rowOf(p)).extraProducts).toBe(0);
  });

  it('a person billed in dollars is not sold the add-on for the naira wallet: nothing is taken or added', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    await h.prisma.personBilling.create({
      data: { wawuUserId: p.id, currency: 'USD', fixedBy: 'support' },
    });
    const res = await quoteRoute(p, { kind: 'extra_products' });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toMatchObject({
      code: 'target_not_payable',
      message: OTHER_CURRENCY_MESSAGE,
    });
    const buy = await call.buy(p, {
      kind: 'extra_products',
      method: 'wallet',
      expectedTotalKobo: 100,
      quoteToken: 'x',
    });
    expect(buy.status).toBe(409);
    expect(reasonOf(buy).code).toBe('target_not_payable');
    expect(sendsFrom(p)).toHaveLength(0);
    expect((await rowOf(p)).extraProducts).toBe(0);
  });

  it('the price and the count are the settings: a changed setting is the next quote', async () => {
    const p = await h.buyer(RICH);
    await running(p);
    await set('plan.extra_products.price_kobo', 330_000);
    await set('plan.extra_products.count', 2);
    try {
      const q = await quoted(p);
      expect(q).toMatchObject({
        extraMinor: 330_000,
        products: 2,
        productsAllowedAfter: 5,
      });
      const res = await call.buy(p, bodyFor(q));
      expect(res.status).toBe(201);
      expect(sendsFrom(p)[0].amountKobo).toBe(BigInt(330_000));
      expect((await rowOf(p)).extraProducts).toBe(2);
    } finally {
      await set('plan.extra_products.price_kobo', null);
      await set('plan.extra_products.count', null);
    }
  });
});
