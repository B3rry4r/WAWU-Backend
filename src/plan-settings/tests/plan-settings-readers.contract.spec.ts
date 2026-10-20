import { randomUUID } from 'node:crypto';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { AdminRole } from '../../../generated/prisma/enums';
import { body } from '../../../test/payments/poll-helpers';
import {
  api,
  bootTierApp,
  type TierHarness,
} from '../../../test/plans/tier-purchase-harness';
import {
  FintavaCashOut,
  MERCHANT_ACCOUNT,
} from '../../../test/points/cash-out-harness';
import { loadPlansConfig } from '../../plans/plans-config';
import type { MyTierView, PlansView } from '../../plans/plans-view.type';
import type { PlanPurchaseQuoteView } from '../../plans/purchases/plan-purchase-view.type';
import type { PointsConvertQuoteView } from '../../points/convert/points-convert-view.type';
import { PlanSettingsService } from '../plan-settings.service';
import request from 'supertest';

/**
 * The readers of the plan follow an admin change with no restart (TIER-06,
 * R-65): GET /plans, the tier quote, the pass on GET /me/tier and the points
 * convert quote, each on the real app and a real database. The admin route and
 * its refusals are proved in admin-plan-settings.contract.spec.ts; here the
 * change goes through the same service the route calls.
 */

jest.setTimeout(300_000);

const seed = loadPlansConfig();
const admin: AdminActor = {
  id: randomUUID(),
  email: 'tier06-readers@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const byPrice = [...seed.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const big = byPrice[byPrice.length - 1];

async function clearSettings(h: {
  get: TierHarness['get'];
  prisma: TierHarness['prisma'];
}) {
  await h.prisma.planSetting.deleteMany({});
  await h.get(PlanSettingsService).refresh();
}

describe('GET /plans, the tier quote and the pass follow an admin change (TIER-06)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let settings: PlanSettingsService;

  beforeAll(async () => {
    h = await bootTierApp('t06');
    call = api(h);
    settings = h.get(PlanSettingsService);
  });
  afterAll(async () => {
    await clearSettings(h);
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.close();
  });
  afterEach(() => clearSettings(h));

  const plans = (auth: string) =>
    request(h.app.getHttpServer())
      .get('/api/hub/plans')
      .set('Authorization', auth);

  it('a tier price and the add-on price on GET /plans, and the tier quote, change at once', async () => {
    const p = await h.buyer(100 * big.price.kobo);
    const before = body<PlansView>(await plans(p.auth).expect(200)).data!;
    const quoteBefore = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id }).expect(200),
    ).data!;
    expect(quoteBefore.planMinor).toBe(small.price.kobo);

    await settings.set(admin, {
      settings: {
        [`plan.tier.${small.id}.price_kobo`]: small.price.kobo + 25_000,
        'plan.extra_products.price_kobo': 175_000,
        'points.daily_cap': 4000,
        'plan.pack.m.price_kobo': 240_000,
      },
    });

    const after = body<PlansView>(await plans(p.auth).expect(200)).data!;
    expect(after.tiers.find((t) => t.id === small.id)!.priceMinor).toBe(
      small.price.kobo + 25_000,
    );
    expect(after.extraProducts.priceMinor).toBe(175_000);
    expect(after.caps.dailyPoints).toBe(4000);
    expect(after.packs.find((x) => x.id === 'm')!.priceMinor).toBe(240_000);
    // What was not changed reads as before.
    expect(after.tiers.find((t) => t.id === big.id)).toEqual(
      before.tiers.find((t) => t.id === big.id),
    );
    const quoteAfter = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id }).expect(200),
    ).data!;
    expect(quoteAfter.planMinor).toBe(small.price.kobo + 25_000);
    expect(quoteAfter.payment.priceKobo).toBe(small.price.kobo + 25_000);
  });

  it('every lot lasts the months the setting says, on GET /plans', async () => {
    const p = await h.buyer(0);
    await settings.set(admin, { settings: { 'points.expiry_months': 6 } });
    const v = body<PlansView>(await plans(p.auth).expect(200)).data!;
    const days = new Set(v.tiers.map((t) => t.bonusPointsExpireDays));
    expect([...days]).toHaveLength(1);
    expect([...days][0]).toBeLessThan(200);
  });

  it('the pass carries its lines and the event date only once they are set (G-804)', async () => {
    const p = await h.buyer(0);
    await h.prisma.eventPass.create({
      data: {
        wawuUserId: p.id,
        type: seed.eventPasses[seed.eventPasses.length - 1].id,
        purchaseRef: `test-${randomUUID()}`,
      },
    });
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId: big.id,
        activeFrom: new Date(Date.now() - big.days * 86_400_000),
        activeUntil: new Date(Date.now() + 40 * 86_400_000),
        productsIncluded: big.products,
        extraProducts: 0,
        pointsIncluded: big.bonusPoints,
        voiceIntroIncluded: big.firstVoiceIntro,
      },
    });
    const read = async () =>
      body<MyTierView>(await call.tier(p).expect(200)).data!.eventPass!;

    // Nothing is set at launch: the pass reads exactly as it did.
    const bare = await read();
    expect('benefits' in bare).toBe(false);
    // No date until the owner sets one: the field is left out.
    expect('eventDate' in bare).toBe(false);

    await settings.set(admin, {
      settings: { 'plan.event_date': '2026-12-19' },
    });
    expect((await read()).eventDate).toBe('2026-12-19');

    await settings.set(admin, {
      settings: {
        'plan.event_pass.maker_pass_priority.benefits': ['Only this line'],
      },
    });
    expect((await read()).benefits).toEqual(['Only this line']);
    expect((await read()).eventDate).toBe('2026-12-19');
  });
});

describe('The points convert quote follows an admin change (TIER-06)', () => {
  const h = new FintavaCashOut();
  const RATE = seed.cashOut.per1000Points.kobo;
  const MIN = seed.cashOut.minimumPoints;

  beforeAll(async () => {
    await h.boot();
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 50_000_000);
  });
  afterAll(async () => {
    await h.prisma.planSetting.deleteMany({});
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.close();
  });

  it('a new rate and a new minimum are the next quote, with no restart; a zero is refused', async () => {
    const settings = h.moduleRef.get(PlanSettingsService);
    const p = await h.person(0);
    await h.lots(p, [{ points: MIN + 750, days: 30 }]);

    const before = body<PointsConvertQuoteView>(await h.quote(p)).data!;
    expect(before.rate.kobo).toBe(RATE);
    expect(before.cashKobo).toBe(Math.floor(((MIN + 750) * RATE) / 1000));

    await settings.set(admin, {
      settings: {
        'points.cash_rate_kobo_per_1000': RATE + 10_000,
        'points.cash_out_minimum_points': MIN + 100,
      },
    });
    const after = body<PointsConvertQuoteView>(await h.quote(p)).data!;
    expect(after.rate.kobo).toBe(RATE + 10_000);
    expect(after.minimumPoints).toBe(MIN + 100);
    expect(after.cashKobo).toBe(
      Math.floor(((MIN + 750) * (RATE + 10_000)) / 1000),
    );

    await expect(
      settings.set(admin, {
        settings: { 'points.cash_rate_kobo_per_1000': 0 },
      }),
    ).rejects.toThrow(/points\.cash_rate_kobo_per_1000/);
    const same = body<PointsConvertQuoteView>(await h.quote(p)).data!;
    expect(same.rate.kobo).toBe(RATE + 10_000);

    await settings.set(admin, {
      settings: {
        'points.cash_rate_kobo_per_1000': null,
        'points.cash_out_minimum_points': null,
      },
    });
    const back = body<PointsConvertQuoteView>(await h.quote(p)).data!;
    expect(back.rate.kobo).toBe(RATE);
    expect(back.minimumPoints).toBe(MIN);
  });
});
