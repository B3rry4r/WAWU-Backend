import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import request from 'supertest';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { AdminRole } from '../../../generated/prisma/enums';
import { body } from '../../../test/payments/poll-helpers';
import {
  api,
  bootTierApp,
  type TierHarness,
} from '../../../test/plans/tier-purchase-harness';
import {
  BASE,
  FintavaCashOut,
  MERCHANT_ACCOUNT,
  PIN,
} from '../../../test/points/cash-out-harness';
import { loadPlansConfig, percentOf } from '../../plans/plans-config';
import { TierGrantService } from '../../plans/tier-grant.service';
import type { PlanPurchaseQuoteView } from '../../plans/purchases/plan-purchase-view.type';
import type {
  PointsConversionView,
  PointsConvertQuoteView,
} from '../../points/convert/points-convert-view.type';
import { PlanSettingsService } from '../plan-settings.service';

/**
 * TIER-06 round 2 (the verifier's findings 1 to 7): what a person is shown is
 * what they get. A points cash-out pays the quote it was bound to, or nothing;
 * a tier purchase grants the goods its quote showed, even when the plan is
 * changed while the payment confirms; the third referral milestone is off at
 * launch; the cash rate can never be set above what points are sold for; and
 * the audit trail of parallel changes is true. Real app, real database.
 */

jest.setTimeout(300_000);

const seed = loadPlansConfig();
const admin: AdminActor = {
  id: randomUUID(),
  email: 'tier06-round2@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const byPrice = [...seed.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const RATE = seed.cashOut.per1000Points.kobo;

type QuoteBody = PointsConvertQuoteView & { quoteToken?: string };

async function clearSettings(h: {
  moduleRef?: { get: (t: typeof PlanSettingsService) => PlanSettingsService };
  get?: TierHarness['get'];
  prisma: TierHarness['prisma'];
}) {
  await h.prisma.planSetting.deleteMany({});
  const svc = h.get
    ? h.get(PlanSettingsService)
    : h.moduleRef!.get(PlanSettingsService);
  await svc.refresh();
}

describe('a points cash-out pays the quote it was bound to, or nothing (finding 1)', () => {
  const h = new FintavaCashOut();
  let settings: PlanSettingsService;

  beforeAll(async () => {
    await h.boot();
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 500_000_000);
    settings = h.moduleRef.get(PlanSettingsService);
  });
  afterAll(async () => {
    await clearSettings(h);
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.close();
  });
  afterEach(() => clearSettings(h));

  const post = (
    p: { auth: string },
    payload: Record<string, unknown>,
    pin = PIN,
  ) =>
    request(h.app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', pin)
      .send(payload);

  const quoted = async (p: { auth: string }, points: number) =>
    body<QuoteBody>(await h.quote(p, `?points=${points}`).expect(200)).data!;

  const unchanged = async (p: {
    id: string;
    accountNumber: string;
    auth: string;
  }) => ({
    wallet: h.wallets.kobo.get(p.accountNumber),
    conversions: await h.prisma.pointConversion.count({
      where: { wawuUserId: p.id },
    }),
    balance: body<QuoteBody>(await h.quote(p, '?points=1000').expect(200)).data!
      .balancePoints,
  });

  it('a rate changed after the quote pays nothing: 409 quote_changed with the new quote, and a fresh quote then pays the new figure', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 4000, days: 30 }]);
    const q = await quoted(p, 4000);
    expect(q.cashKobo).toBe(Math.floor((4000 * RATE) / 1000));
    const before = await unchanged(p);

    await settings.set(admin, {
      settings: { 'points.cash_rate_kobo_per_1000': RATE + 10_000 },
    });
    const res = await post(p, { points: 4000, quoteToken: q.quoteToken });
    expect(res.status).toBe(409);
    const reason = body<unknown>(res).reason as unknown as {
      code: string;
      pointsQuote?: PointsConvertQuoteView;
    };
    expect(reason.code).toBe('quote_changed');
    expect(reason.pointsQuote?.rate.kobo).toBe(RATE + 10_000);
    expect(reason.pointsQuote?.cashKobo).toBe(
      Math.floor((4000 * (RATE + 10_000)) / 1000),
    );
    expect(await unchanged(p)).toEqual(before);

    const fresh = await quoted(p, 4000);
    const ok = await post(p, { points: 4000, quoteToken: fresh.quoteToken });
    expect(ok.status).toBe(201);
    expect(body<PointsConversionView>(ok).data!.cashKobo).toBe(fresh.cashKobo);
    expect(fresh.cashKobo).toBe(Math.floor((4000 * (RATE + 10_000)) / 1000));
  });

  it('a rate lowered after the quote is refused the same way (the person is never paid less than shown either)', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 4000, days: 30 }]);
    const q = await quoted(p, 4000);
    const before = await unchanged(p);
    await settings.set(admin, {
      settings: { 'points.cash_rate_kobo_per_1000': Math.floor(RATE / 4) },
    });
    const res = await post(p, { points: 4000, quoteToken: q.quoteToken });
    expect(res.status).toBe(409);
    expect(
      (body<unknown>(res).reason as unknown as { code: string }).code,
    ).toBe('quote_changed');
    expect(await unchanged(p)).toEqual(before);
  });

  it('a quote that still stands pays exactly what it showed', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2500, days: 30 }]);
    const q = await quoted(p, 2500);
    const res = await post(p, { points: 2500, quoteToken: q.quoteToken });
    expect(res.status).toBe(201);
    const view = body<PointsConversionView>(res).data!;
    expect(view.cashKobo).toBe(q.cashKobo);
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(q.cashKobo);
  });

  it('a convert with no quote token is a plain 400 before the PIN: nothing is paid and no PIN try is used', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2000, days: 30 }]);
    const before = await unchanged(p);
    // A wrong PIN would be `pin_incorrect` (and use a try) if the PIN were reached.
    const res = await post(p, { points: 2000 }, '0000');
    expect(res.status).toBe(400);
    expect(body<unknown>(res).reason).toBeUndefined();
    expect(await unchanged(p)).toEqual(before);
  });

  it('a token for other points, for another person, or one made up is quote_changed, never a payment', async () => {
    const p = await h.person(0);
    const other = await h.person(0);
    await h.lots(p, [{ points: 4000, days: 30 }]);
    await h.lots(other, [{ points: 4000, days: 30 }]);
    const mine = await quoted(p, 2000);
    const theirs = await quoted(other, 2000);
    const before = await unchanged(p);
    for (const [points, token] of [
      [3000, mine.quoteToken],
      [2000, theirs.quoteToken],
      [2000, 'not-a-token'],
      [2000, `${mine.quoteToken}x`],
    ] as const) {
      const res = await post(p, { points, quoteToken: token });
      expect(res.status).toBe(409);
      expect(
        (body<unknown>(res).reason as unknown as { code: string }).code,
      ).toBe('quote_changed');
    }
    expect(await unchanged(p)).toEqual(before);
  });

  it('a quote past its end is quote_changed, never a payment', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2000, days: 30 }]);
    const q = await quoted(p, 2000);
    const before = await unchanged(p);
    const real = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(real + 400_000);
    try {
      const res = await post(p, { points: 2000, quoteToken: q.quoteToken });
      expect(res.status).toBe(409);
      expect(
        (body<unknown>(res).reason as unknown as { code: string }).code,
      ).toBe('quote_changed');
    } finally {
      clock.mockRestore();
    }
    expect(await unchanged(p)).toEqual(before);
  });

  it('the minimum is a figure the quote shows: changed after the quote, the quote is stale', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 4000, days: 30 }]);
    const q = await quoted(p, 2000);
    await settings.set(admin, {
      settings: { 'points.cash_out_minimum_points': 1500 },
    });
    const res = await post(p, { points: 2000, quoteToken: q.quoteToken });
    expect(res.status).toBe(409);
    expect(
      (body<unknown>(res).reason as unknown as { code: string }).code,
    ).toBe('quote_changed');
  });
});

describe('a tier purchase grants the goods its quote showed (finding 2)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let settings: PlanSettingsService;

  beforeAll(async () => {
    h = await bootTierApp('t06r2');
    call = api(h);
    settings = h.get(PlanSettingsService);
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 1_000_000_000);
  });
  afterAll(async () => {
    await clearSettings(h);
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.close();
  });
  afterEach(async () => {
    h.wallets.mode = 'live';
    await clearSettings(h);
  });

  const goodsChange = {
    'plan.checkout_bump.points': 100,
    [`plan.tier.${small.id}.products`]: 1,
    [`plan.tier.${small.id}.bonus_points`]: 7,
  };
  const buyBody = (q: PlanPurchaseQuoteView) => ({
    kind: 'tier',
    tierId: small.id,
    bump: true,
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });

  it('goods changed between the quote and the pay: 409 quote_changed, nothing debited or granted; a fresh quote buys the new goods', async () => {
    const p = await h.buyer(50 * small.price.kobo);
    const q = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id, bump: true }),
    ).data!;
    const wallet = h.wallets.kobo.get(p.accountNumber);

    await settings.set(admin, { settings: goodsChange });
    const stale = await call.buy(p, buyBody(q));
    expect(stale.status).toBe(409);
    expect(
      (body<unknown>(stale).reason as unknown as { code: string }).code,
    ).toBe('quote_changed');
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(wallet);
    expect(
      await h.prisma.makerTier.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);

    const fresh = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id, bump: true }),
    ).data!;
    expect(fresh.bumpPoints).toBe(100);
    const ok = await call.buy(p, buyBody(fresh));
    expect(ok.status).toBe(201);
    const tier = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(tier.productsIncluded).toBe(1);
    expect(tier.pointsIncluded).toBe(7);
  });

  it('a payment still confirming when the plan is changed is granted what it was bought as, not what the plan says now', async () => {
    const p = await h.buyer(50 * small.price.kobo);
    const q = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id, bump: true }),
    ).data!;
    expect(q.bumpPoints).toBeGreaterThan(100);

    h.wallets.mode = 'timeout';
    const res = await call.buy(p, buyBody(q));
    h.wallets.mode = 'live';
    expect(res.status).toBe(201);
    const pending = body<{ id: string; status: string }>(res).data!;
    expect(pending.status).toBe('pending');

    // The owner changes the plan while the payment confirms.
    await settings.set(admin, {
      settings: {
        ...goodsChange,
        [`plan.tier.${small.id}.days`]: 5,
        'points.expiry_months': 1,
      },
    });
    await h.sweepLater();

    const tier = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(tier.productsIncluded).toBe(small.products);
    expect(tier.pointsIncluded).toBe(small.bonusPoints);
    const days = Math.round(
      (tier.activeUntil.getTime() - tier.activeFrom.getTime()) / 86_400_000,
    );
    expect(days).toBe(small.days);
    const bump = await h.prisma.pointLot.findFirstOrThrow({
      where: { wawuUserId: p.id, source: 'bump' },
    });
    expect(bump.quantity).toBe(q.bumpPoints);
    const bonus = await h.prisma.pointLot.findFirstOrThrow({
      where: { wawuUserId: p.id, source: 'tier_bonus' },
    });
    expect(bonus.quantity).toBe(small.bonusPoints);
    const lotDays = Math.round(
      (bonus.expiresAt.getTime() - Date.now()) / 86_400_000,
    );
    expect(lotDays).toBeGreaterThan(300);
  });
  it('an upgrade still confirming when the bigger tier is changed is granted the tier as it was quoted', async () => {
    const big = byPrice[byPrice.length - 1];
    const p = await h.buyer(100 * big.price.kobo);
    await h.prisma.$transaction((tx) =>
      h.get(TierGrantService).grant(tx, {
        wawuUserId: p.id,
        tierId: small.id,
        sourceRef: `seed:${randomUUID()}`,
        days: 20,
      }),
    );
    const q = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'upgrade', tierId: big.id }),
    ).data!;
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, {
      kind: 'upgrade',
      tierId: big.id,
      method: 'wallet',
      expectedTotalKobo: q.payment.totalKobo,
      quoteToken: q.payment.quoteToken,
    });
    h.wallets.mode = 'live';
    expect(body<{ status: string }>(res).data!.status).toBe('pending');

    await settings.set(admin, {
      settings: {
        [`plan.tier.${big.id}.products`]: 1,
        [`plan.tier.${big.id}.bonus_points`]: 9,
      },
    });
    await h.sweepLater();
    const tier = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(tier.tierId).toBe(big.id);
    expect(tier.productsIncluded).toBe(big.products);
    expect(tier.pointsIncluded).toBe(big.bonusPoints);
  });
});

describe('the third referral milestone is off at launch (finding 3)', () => {
  it('the default list holds only the drawn steps, and the missing one can still be added in admin', async () => {
    expect(seed.referral.milestones).toEqual([
      { count: 5, points: 500 },
      { count: 10, points: 1500 },
    ]);
    const h = await bootTierApp('t06r2m');
    try {
      const settings = h.get(PlanSettingsService);
      const view = settings
        .describe()
        .settings.find((s) => s.key === 'referral.milestones')!;
      expect(view.value).toEqual(seed.referral.milestones);
      expect(view.source).toBe('default');
      await settings.set(admin, {
        settings: {
          'referral.milestones': [
            ...seed.referral.milestones,
            { count: 25, points: 5000 },
          ],
        },
      });
      expect(settings.current().referral.milestones).toHaveLength(3);
    } finally {
      await clearSettings(h);
      await h.prisma.adminOpsAudit.deleteMany({
        where: { actedByAdminId: admin.id },
      });
      await h.close();
    }
  });
});

describe('the cash rate can never be set above what points are sold for (finding 7)', () => {
  let h: TierHarness;
  let settings: PlanSettingsService;
  const CASH = 'points.cash_rate_kobo_per_1000';
  // What 1,000 points sell for, the cheapest first, as the seed has it. A pack
  // counts the Founding bonus (POINTS-02): its buyer gets the largest extra
  // percent of any tier on top of the pack's points.
  const bonusPct = Math.max(...seed.tiers.map((t) => t.packBonusPct));
  const sales = [
    ...seed.packs.map((p) => ({
      key: `plan.pack.${p.id}.price_kobo`,
      per1000: Math.floor(
        (p.price.kobo * 1000) /
          (p.points.NGN + percentOf(p.points.NGN, bonusPct)),
      ),
    })),
    {
      key: 'plan.checkout_bump.price_kobo',
      per1000: Math.floor(
        (seed.checkoutBump.price.kobo * 1000) / seed.checkoutBump.points.NGN,
      ),
    },
    {
      key: 'points.price_kobo_per_1000',
      per1000: seed.points.pricePer1000Points.kobo,
    },
  ].sort((a, b) => a.per1000 - b.per1000);
  const cheapest = sales[0];

  beforeAll(async () => {
    h = await bootTierApp('t06r2c');
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

  const refused = async (change: Record<string, unknown>) => {
    const err = await settings.set(admin, { settings: change }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).message;
  };

  it('a cash rate above the cheapest sale is a 400 that names both settings, and stores nothing', async () => {
    const said = await refused({ [CASH]: cheapest.per1000 + 1 });
    expect(said).toContain(CASH);
    expect(said).toContain(cheapest.key);
    expect(await h.prisma.planSetting.count()).toBe(0);
    expect(
      await h.prisma.adminOpsAudit.count({
        where: { actedByAdminId: admin.id, resourceId: CASH },
      }),
    ).toBe(0);
  });

  it('exactly the cheapest sale is allowed', async () => {
    await settings.set(admin, { settings: { [CASH]: cheapest.per1000 } });
    expect(settings.current().cashOut.per1000Points.kobo).toBe(
      cheapest.per1000,
    );
  });

  it('the other order: a sale price cut below the cash rate in force is refused, naming both', async () => {
    await settings.set(admin, { settings: { [CASH]: 70_000 } });
    const said = await refused({ 'plan.pack.l.price_kobo': 400_000 });
    expect(said).toContain(CASH);
    expect(said).toContain('plan.pack.l.price_kobo');
    // Fewer points for the same price is the same cut.
    const fewer = await refused({ 'plan.checkout_bump.points': 2000 });
    expect(fewer).toContain(CASH);
    expect(fewer).toContain('plan.checkout_bump');
    expect(settings.current().packs.find((x) => x.id === 'l')!.price.kobo).toBe(
      seed.packs.find((x) => x.id === 'l')!.price.kobo,
    );
  });

  it('one request that moves both to a consistent pair is allowed', async () => {
    await settings.set(admin, {
      settings: {
        [CASH]: 80_000,
        'plan.pack.l.price_kobo': 530_000,
      },
    });
    expect(settings.current().cashOut.per1000Points.kobo).toBe(80_000);
  });

  it('one request that moves the cash rate, a pack price and the checkout bump together is allowed as a consistent triple and refused when the bump is the one out of line (POINTS-02 L3)', async () => {
    // Bump: 1,000 points. A pack-l price of 600,000 sells 6,600 points with the
    // Founding bonus (about 90,900 per 1,000), above the 80,000 cash rate.
    const bumpKey = 'plan.checkout_bump.price_kobo';
    const triple = (bump: number) => ({
      [CASH]: 80_000,
      'plan.pack.l.price_kobo': 600_000,
      [bumpKey]: bump,
    });
    const said = await refused(triple(79_000));
    expect(said).toContain(CASH);
    expect(said).toContain('plan.checkout_bump');
    expect(await h.prisma.planSetting.count()).toBe(0);
    await settings.set(admin, { settings: triple(90_000) });
    expect(settings.current().cashOut.per1000Points.kobo).toBe(80_000);
    expect(settings.current().checkoutBump.price.kobo).toBe(90_000);
    expect(settings.current().packs.find((x) => x.id === 'l')!.price.kobo).toBe(
      600_000,
    );
  });

  it('putting the cash rate back to its default is always allowed', async () => {
    await settings.set(admin, { settings: { [CASH]: 70_000 } });
    await settings.set(admin, { settings: { [CASH]: null } });
    expect(settings.current().cashOut.per1000Points.kobo).toBe(RATE);
  });

  it('a change to something else is not held up by a pair that was already out of line', async () => {
    await h.prisma.planSetting.create({
      data: { key: CASH, value: (cheapest.per1000 + 5000) as never },
    });
    await settings.refresh();
    await settings.set(admin, { settings: { 'points.daily_cap': 4321 } });
    expect(settings.current().caps.dailyPointsPerUser).toBe(4321);
  });
});

describe('every audit row says what the value really was (finding 4)', () => {
  let h: TierHarness;
  let settings: PlanSettingsService;
  const KEY = 'points.daily_cap';

  beforeAll(async () => {
    h = await bootTierApp('t06r2a');
    settings = h.get(PlanSettingsService);
  });
  afterAll(async () => {
    await clearSettings(h);
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.close();
  });

  it('twelve saves of one key at once leave one unbroken chain from the default to the last value', async () => {
    const values = Array.from({ length: 12 }, (_, i) => 6000 + 2 * i);
    await Promise.all(
      values.map((v) => settings.set(admin, { settings: { [KEY]: v } })),
    );
    const rows = await h.prisma.adminOpsAudit.findMany({
      where: { actedByAdminId: admin.id, resourceId: KEY },
    });
    expect(rows).toHaveLength(12);
    const steps = rows.map((r) => {
      const d = r.detail as { from: number; to: number };
      return { from: d.from, to: d.to };
    });
    // Each value is left once and entered once, so the rows form one path.
    const next = new Map(steps.map((s) => [s.from, s.to]));
    expect(next.size).toBe(12);
    let at = seed.caps.dailyPointsPerUser;
    for (let i = 0; i < 12; i += 1) {
      expect(next.has(at)).toBe(true);
      at = next.get(at)!;
    }
    expect(settings.number(KEY)).toBe(at);
    expect(at).toBeGreaterThanOrEqual(6000);
  });
});

describe('the migration can be applied again after its rollback (finding 6)', () => {
  let h: TierHarness;
  beforeAll(async () => {
    h = await bootTierApp('t06r2g');
  });
  afterAll(async () => {
    await h.close();
  });

  it('every enum value it adds says IF NOT EXISTS, and a second run after DROP TABLE succeeds', async () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261024060000_plan_settings/migration.sql',
      ),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    for (const s of statements.filter((x) => /ADD VALUE/.test(x))) {
      expect(s).toMatch(/ADD VALUE IF NOT EXISTS/);
    }
    await h.prisma.$executeRawUnsafe('DROP TABLE "PlanSetting"');
    for (const s of statements) await h.prisma.$executeRawUnsafe(s);
    expect(await h.prisma.planSetting.count()).toBe(0);
  });
});
