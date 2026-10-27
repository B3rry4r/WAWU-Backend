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
  PACK_AT_MOST_MESSAGE,
  PACK_NOT_ALLOWED_CODE,
  PACK_TIER_MESSAGE,
} from '../extra-products-cap';
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
  async function hold(p: Person, tierId: string, extraProducts = 0) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId,
        activeFrom: new Date(Date.now() - 10 * DAY),
        activeUntil: new Date(Date.now() + 100 * DAY),
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
});
