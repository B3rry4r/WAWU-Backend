import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import { lastValueFrom, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
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
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { loadPlansConfig, priceIn } from '../../plans-config';
import { PublishingAllowanceService } from '../../publishing-allowance.service';
import { PublishingGate } from '../../publishing-gate.service';
import { PublishingOffersInterceptor } from '../../publishing-offers.interceptor';
import { TierGateError } from '../../tier-gate-error';
import {
  PACK_NO_ROOM_MESSAGE,
  PACK_AT_MOST_MESSAGE,
  PACK_NOT_ALLOWED_CODE,
  PACK_TIER_MESSAGE,
} from '../extra-products-cap';
import {
  TIER_ENDED_MESSAGE,
  TIER_REQUIRED_MESSAGE,
} from '../extra-products-rules';
import type {
  ExtraProductsPurchaseView,
  ExtraProductsQuoteView,
} from '../extra-products-view.type';

/**
 * PACK-CAP (R-100) over HTTP, on the real money, plans and purchase modules
 * with NUVION stood in (R-39): "Add 5 more products" is sold only to a person
 * whose running tier the settings name (Founding Maker), at most two packs.
 * Verify and Verify Plus are offered tiers only. The quote and the purchase
 * answer `pack_not_allowed` before anything moves. No Nuvion or Fintava host
 * is called.
 */

jest.setTimeout(120_000);

const NUVION_FEE = 2325;
const DAY = 86_400_000;
const config = loadPlansConfig();
const addOn = config.extraProducts;
const addOnPrice = priceIn(addOn.price, 'NGN');
const RICH = 100 * addOnPrice;
const tierOf = (id: string) => config.tiers.find((t) => t.id === id)!;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'packcap@admin.test.wawu.dev',
  role: AdminRole.finance,
};

describe('PACK-CAP: only Founding Maker adds products, at most two packs', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let settings: PlanSettingsService;
  let allowance: PublishingAllowanceService;
  let gate: PublishingGate;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootTierApp('pc2', { nuvion, nuvionFeeKobo: NUVION_FEE });
    call = api(h);
    settings = h.get(PlanSettingsService);
    allowance = h.get(PublishingAllowanceService);
    gate = h.get(PublishingGate);
  });
  afterAll(async () => {
    await settings.set(admin, {
      settings: {
        'plan.extra_products.tiers': null,
        'plan.extra_products.max_packs': null,
      },
    });
    await h.prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    await h.prisma.makerExtraProducts.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    await h.close();
  });
  beforeEach(async () => {
    nuvion.mode = 'successful';
    await settings.set(admin, {
      settings: {
        'plan.extra_products.tiers': null,
        'plan.extra_products.max_packs': null,
      },
    });
  });

  const data = <T>(res: Response) => body<T>(res).data!;
  const reasonOf = (res: Response) =>
    body<unknown>(res).reason as unknown as { code: string; message: string };
  const quoteRoute = (p: Person) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/plans/purchases/quote?kind=extra_products`)
      .set('Authorization', p.auth);
  const bodyFor = (q: ExtraProductsQuoteView) => ({
    kind: 'extra_products',
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  /** Quote, then pay with the PIN: what the app does. */
  async function buyPack(p: Person) {
    const q = await quoteRoute(p);
    expect(q.status).toBe(200);
    const res = await call.buy(p, bodyFor(data<ExtraProductsQuoteView>(q)));
    expect(res.status).toBe(201);
    return data<ExtraProductsPurchaseView>(res);
  }
  async function hold(
    p: Person,
    tierId: string,
    extraProducts = 0,
    state: 'running' | 'ended' = 'running',
  ) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId,
        activeFrom: new Date(Date.now() - 40 * DAY),
        activeUntil: new Date(
          Date.now() + (state === 'running' ? 100 : -10) * DAY,
        ),
        productsIncluded: tierOf(tierId).products,
        extraProducts,
        pointsIncluded: 0,
        voiceIntroIncluded: false,
      },
    });
  }
  const publish = (p: Person, used: number) =>
    h.prisma.creatorState.upsert({
      where: { wawuUserId: p.id },
      create: { wawuUserId: p.id, slotsUsed: used },
      update: { slotsUsed: used },
    });
  const extraOf = async (p: Person) =>
    (
      await h.prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      })
    ).extraProducts;
  const packsBought = (p: Person) =>
    h.prisma.makerExtraProducts.count({ where: { wawuUserId: p.id } });
  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account!.accountId);
  const set = (key: string, value: number | string[]) =>
    settings.set(admin, { settings: { [key]: value } });

  /** What the publishing routes' interceptor adds to a full profile's refusal. */
  async function offersFor(p: Person) {
    const interceptor = h.get(PublishingOffersInterceptor);
    const refusal = await gate.assertRoomForProduct(p.id).then(
      () => null,
      (e: unknown) => e as TierGateError,
    );
    expect(refusal).toBeInstanceOf(TierGateError);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { sub: p.id } }) }),
    } as unknown as ExecutionContext;
    const next = { handle: () => throwError(() => refusal) } as CallHandler;
    return lastValueFrom(interceptor.intercept(ctx, next)).then(
      () => {
        throw new Error('should have refused');
      },
      (e: TierGateError) => e,
    );
  }

  for (const [id, label] of [
    ['verify', 'Verify'],
    ['plus', 'Verify Plus'],
  ] as const) {
    it(`${label}, full: the refusal offers tiers only, and the quote and the purchase answer pack_not_allowed with nothing taken`, async () => {
      const p = await h.buyer(RICH);
      await hold(p, id);
      await publish(p, tierOf(id).products);

      const refused = await offersFor(p);
      expect(refused.code).toBe('product_limit_reached');
      const offers = refused.offers!;
      expect(offers.extraProducts).toBeNull();
      expect(offers.tiers.length).toBeGreaterThan(0);
      expect(offers.tiers.map((t) => t.id)).not.toContain(id);

      const quote = await quoteRoute(p);
      expect(quote.status).toBe(409);
      expect(reasonOf(quote)).toEqual({
        code: PACK_NOT_ALLOWED_CODE,
        message: PACK_TIER_MESSAGE,
      });

      // A quote taken while the settings named this tier, paid after they
      // stopped naming it: the purchase is refused with the same code.
      await set('plan.extra_products.tiers', [id, 'founding']);
      const open = data<ExtraProductsQuoteView>(await quoteRoute(p));
      await set('plan.extra_products.tiers', ['founding']);
      const res = await call.buy(p, bodyFor(open));
      expect(res.status).toBe(409);
      expect(reasonOf(res)).toEqual({
        code: PACK_NOT_ALLOWED_CODE,
        message: PACK_TIER_MESSAGE,
      });

      expect(sendsFrom(p)).toHaveLength(0);
      expect(await extraOf(p)).toBe(0);
      expect(await packsBought(p)).toBe(0);
    });
  }

  it('Founding Maker buys a first pack, a second pack, then is offered nothing at 20 of 20', async () => {
    const p = await h.buyer(RICH);
    await hold(p, 'founding');
    const included = tierOf('founding').products;
    await publish(p, included);
    expect((await offersFor(p)).offers!.extraProducts).toEqual({
      count: addOn.count,
      priceMinor: addOnPrice,
    });

    const first = await buyPack(p);
    expect(first).toMatchObject({ status: 'paid' });
    expect(await extraOf(p)).toBe(addOn.count);
    await publish(p, included + addOn.count);
    expect((await offersFor(p)).offers!.extraProducts).not.toBeNull();

    const second = await buyPack(p);
    expect(second).toMatchObject({
      status: 'paid',
      grant: { productsAllowed: included + 2 * addOn.count },
    });
    expect(await extraOf(p)).toBe(2 * addOn.count);
    await publish(p, included + 2 * addOn.count);
    expect(await allowance.of(p.id)).toMatchObject({
      productsAllowed: included + 2 * addOn.count,
    });

    const end = (await offersFor(p)).offers!;
    expect(end.extraProducts).toBeNull();
    expect(end.tiers).toEqual([]);

    const debits = sendsFrom(p).length;
    const quote = await quoteRoute(p);
    expect(quote.status).toBe(409);
    expect(reasonOf(quote)).toEqual({
      code: PACK_NOT_ALLOWED_CODE,
      message: PACK_AT_MOST_MESSAGE,
    });
    expect(sendsFrom(p)).toHaveLength(debits);
    expect(await extraOf(p)).toBe(2 * addOn.count);
    expect(await packsBought(p)).toBe(2);
  });

  it('the settings change the rule: Verify can buy when its tier is named, and a third pack when three are allowed', async () => {
    const v = await h.buyer(RICH);
    await hold(v, 'verify');
    expect((await quoteRoute(v)).status).toBe(409);
    await set('plan.extra_products.tiers', ['verify', 'founding']);
    expect(await buyPack(v)).toMatchObject({ status: 'paid' });
    expect(await extraOf(v)).toBe(addOn.count);

    const f = await h.buyer(RICH);
    await hold(f, 'founding', 2 * addOn.count);
    expect((await quoteRoute(f)).status).toBe(409);
    await set('plan.extra_products.max_packs', 3);
    expect(await buyPack(f)).toMatchObject({ status: 'paid' });
    expect(await extraOf(f)).toBe(3 * addOn.count);

    // And one pack only: a Founding Maker with one pack is stopped.
    const g = await h.buyer(RICH);
    await hold(g, 'founding', addOn.count);
    await set('plan.extra_products.max_packs', 1);
    expect((await quoteRoute(g)).status).toBe(409);
  });

  it('packs bought before the rule stay: Verify keeps its extras, and no further pack is sold to it', async () => {
    const p = await h.buyer(RICH);
    await hold(p, 'verify', addOn.count);
    expect(await extraOf(p)).toBe(addOn.count);
    expect((await quoteRoute(p)).status).toBe(409);
    expect(await extraOf(p)).toBe(addOn.count);
  });

  // ---------------------------------------------------------------------------
  // Round 3: the cap is re-checked where the pack is added, and eligibility
  // comes before the wallet.
  // ---------------------------------------------------------------------------

  it('M1: a pack paid while another channel took the last place is refunded in full and never added (the cap is 20, not 25)', async () => {
    const p = await h.buyer(RICH);
    await hold(p, 'founding', addOn.count);
    const q = data<ExtraProductsQuoteView>(await quoteRoute(p));
    // The provider has not confirmed yet: the payment is claimed and pending.
    nuvion.mode = 'pending';
    const pending = data<ExtraProductsPurchaseView>(
      await call.buy(p, bodyFor(q)),
    );
    expect(pending.status).toBe('pending');
    // A store grant lands meanwhile and takes the second pack.
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: { extraProducts: 2 * addOn.count },
    });
    nuvion.settle(pending.payment!.reference, 'successful');
    await h.sweepLater();
    const done = data<ExtraProductsPurchaseView>(
      await call.read(p, pending.id),
    );
    expect(done.status).toBe('refunded');
    expect(done.grant).toBeNull();
    expect(done.statusMessage).toMatch(/back/);
    expect(done.statusMessage).not.toMatch(/[\u2013\u2014]/);
    // Nothing was added, and the purchase is recorded as a refund hold.
    expect(await extraOf(p)).toBe(2 * addOn.count);
    expect(await packsBought(p)).toBe(0);
    const holdRow = await h.prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: pending.payment!.id },
    });
    expect(Number(holdRow.amountKobo)).toBe(addOnPrice);
    // The whole price went back to the payer, once, however often the sweep runs.
    const back = () =>
      nuvion
        .sendsFrom(nuvion.operational.accountId)
        .filter((s) => s.toAccountId === p.account!.accountId);
    expect(back()).toHaveLength(1);
    expect(back()[0].amountKobo).toBe(BigInt(addOnPrice));
    await h.sweepLater();
    expect(back()).toHaveLength(1);
    expect(await extraOf(p)).toBe(2 * addOn.count);
  });

  it('M2: the quote and the purchase answer pack_not_allowed before wallet_not_open, so a Verify person with no wallet is not shown the pack', async () => {
    const p = await h.walletless();
    await hold(p, 'verify');
    const quote = await quoteRoute(p);
    expect(quote.status).toBe(409);
    expect(reasonOf(quote)).toEqual({
      code: PACK_NOT_ALLOWED_CODE,
      message: PACK_TIER_MESSAGE,
    });
    const res = await request(h.app.getHttpServer())
      .post('/api/hub/plans/purchases')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'extra_products',
        method: 'wallet',
        expectedTotalKobo: 1,
        quoteToken: 'x',
      });
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe(PACK_NOT_ALLOWED_CODE);
    // A Founding Maker with no wallet is eligible, so the wallet gate answers.
    const f = await h.walletless();
    await hold(f, 'founding');
    const fq = await quoteRoute(f);
    expect(fq.status).toBe(409);
    expect(reasonOf(fq).code).toBe('wallet_not_open');
  });

  // ---------------------------------------------------------------------------
  // Round 4: eligibility first, fully (no tier, ended tier, no room).
  // ---------------------------------------------------------------------------

  const payBody = {
    kind: 'extra_products',
    method: 'wallet',
    expectedTotalKobo: 1,
    quoteToken: 'x',
  };
  const buyRaw = (p: Person) =>
    request(h.app.getHttpServer())
      .post('/api/hub/plans/purchases')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .send(payBody);

  it('R4-1: with no tier, or an ended one, the quote and the purchase answer tier_required before wallet_not_open', async () => {
    const none = await h.walletless();
    const ended = await h.walletless();
    await hold(ended, 'founding', 0, 'ended');
    for (const p of [none, ended]) {
      const quote = await quoteRoute(p);
      expect(quote.status).toBe(402);
      expect(reasonOf(quote).code).toBe('tier_required');
      const res = await buyRaw(p);
      expect(res.status).toBe(402);
      expect(reasonOf(res).code).toBe('tier_required');
    }
    expect(reasonOf(await quoteRoute(ended)).message).toBe(TIER_ENDED_MESSAGE);
    expect(reasonOf(await quoteRoute(none)).message).toBe(
      TIER_REQUIRED_MESSAGE,
    );
  });

  it('R4-2: a pack that would not lift the limit above what is published is pack_not_allowed, on the quote and the purchase', async () => {
    await set('plan.extra_products.tiers', ['verify', 'founding']);
    const full = await h.buyer(RICH);
    await hold(full, 'verify');
    // 3 included + 5 = 8 places, 12 published: five more still leave no room.
    await publish(full, 12);
    const quote = await quoteRoute(full);
    expect(quote.status).toBe(409);
    expect(reasonOf(quote)).toEqual({
      code: PACK_NOT_ALLOWED_CODE,
      message: PACK_NO_ROOM_MESSAGE,
    });
    const res = await request(h.app.getHttpServer())
      .post('/api/hub/plans/purchases')
      .set('Authorization', full.auth)
      .set('Idempotency-Key', randomUUID())
      .send(payBody);
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe(PACK_NOT_ALLOWED_CODE);
    expect(sendsFrom(full)).toHaveLength(0);
    // Seven published (8 places): five more lift the limit, so it is sold.
    const room = await h.buyer(RICH);
    await hold(room, 'verify');
    await publish(room, 7);
    expect((await quoteRoute(room)).status).toBe(200);
  });

  it('R4-3: a pack paid for that no longer lifts the limit when it is added is refunded in full and not added', async () => {
    const p = await h.buyer(RICH);
    await hold(p, 'founding');
    await publish(p, tierOf('founding').products);
    const q = data<ExtraProductsQuoteView>(await quoteRoute(p));
    nuvion.mode = 'pending';
    const pending = data<ExtraProductsPurchaseView>(
      await call.buy(p, bodyFor(q)),
    );
    expect(pending.status).toBe('pending');
    // More is published than the pack could ever cover before the payment lands.
    await publish(p, 40);
    nuvion.settle(pending.payment!.reference, 'successful');
    await h.sweepLater();
    const done = data<ExtraProductsPurchaseView>(
      await call.read(p, pending.id),
    );
    expect(done.status).toBe('refunded');
    expect(await extraOf(p)).toBe(0);
    expect(await packsBought(p)).toBe(0);
    const back = nuvion
      .sendsFrom(nuvion.operational.accountId)
      .filter((s) => s.toAccountId === p.account!.accountId);
    expect(back).toHaveLength(1);
    expect(back[0].amountKobo).toBe(BigInt(addOnPrice));
  });
});
