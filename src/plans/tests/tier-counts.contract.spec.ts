/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { CreatorStateModule } from '../../creator-state/creator-state.module';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { purgePersonPoints } from '../../points/points-purge';
import { StorageModule } from '../../storage/storage.module';
import {
  openPackRule,
  resetPackRule,
} from '../../../test/plans/open-pack-rule';
import { PLANS_CONFIG, type PlansConfig } from '../plans-config';
import { PlansModule } from '../plans.module';
import type { MyTierView, PlansView, PlanTierView } from '../plans-view.type';
import { TierGrantService } from '../tier-grant.service';

/**
 * TIER-COUNTS (R-112, owner, 27 Oct 2026): Verify allows 4 products, Verify Plus 8 and Founding Maker 15 (they were 3, 6
 * and 10), and a person who already holds a running tier gets the new count at once (lead ruling, 30 Oct 2026).
 *
 * Proved the way a creator meets it: over HTTP on the real modules and the real database, with the real migration file
 * (`20261224090000_tier_counts`) run on a database that holds the OLD saved counts and people who bought at the old
 * counts. Nothing is faked but the sign-in token, which is minted with the stand-in WAWU ID's key as the other
 * publishing specs do. The migration's own row-by-row rules are in plan-settings/tests/tier-counts-migration.
 *
 * The migration is committed here (an HTTP request cannot see a transaction that is rolled back). It raises every
 * running tier row in the database, which is what it does in production; the three saved settings it touches are saved
 * first and put back after.
 */

jest.setTimeout(180_000);

const DAY = 86_400_000;
const NIGERIAN = '+2348031234567';
const COUNTS = { verify: 4, plus: 8, founding: 15 } as const;
const OLD = { verify: 3, plus: 6, founding: 10 } as const;
const KEYS = [
  'plan.tier.verify.products',
  'plan.tier.plus.products',
  'plan.tier.founding.products',
];
const MIGRATE = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261224090000_tier_counts/migration.sql',
  ),
  'utf8',
);
const STORAGE_ENV: Record<string, string> = {
  STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
  STORAGE_ACCESS_KEY_ID: 'counts-test-key',
  STORAGE_SECRET_ACCESS_KEY: 'counts-test-secret',
  STORAGE_BUCKET: 'counts-test-bucket',
  STORAGE_REGION: 'auto',
};
const admin: AdminActor = {
  id: randomUUID(),
  email: 'tier-counts@admin.test.wawu.dev',
  role: AdminRole.finance,
};

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `counts-${sub}@test.wawu.dev`,
      phone: NIGERIAN,
      firstName: 'Counts',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

type Envelope = { statusCode: number; data: any; reason?: any };
const body = (r: Response): Envelope => r.body as Envelope;
const productsOf = (tiers: PlanTierView[]) =>
  Object.fromEntries(tiers.map((t) => [t.id, t.products]));

describe('Tier product counts (TIER-COUNTS, R-112) as a creator meets them', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let settings: PlanSettingsService;
  let grants: TierGrantService;
  let config: PlansConfig;
  const envSnapshot: Record<string, string | undefined> = {};
  const people: string[] = [];
  let seq = 0;
  let savedSettings: { key: string; value: unknown }[] = [];

  const creator = async (): Promise<string> => {
    const id = randomUUID();
    people.push(id);
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'creator' },
    });
    return id;
  };
  const http = () => request(app.getHttpServer());
  const get = (id: string, path: string) =>
    http()
      .get(`/api/hub${path}`)
      .set('Authorization', `Bearer ${mintToken(id)}`);
  const post = (id: string, path: string, send?: object) =>
    http()
      .post(`/api/hub${path}`)
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .send(send);
  const publish = (id: string) => {
    seq += 1;
    return post(id, '/content', {
      contentType: 'video',
      title: `Counts piece ${seq}`,
      description: 'A piece the tier counts spec makes.',
      category: 'business_entrepreneurship',
      specializations: [],
      accessType: 'paid',
      price: 1500,
      previewAsset: `https://cdn.example.com/p-${seq}.jpg`,
      fullAsset: `https://cdn.example.com/f-${seq}.mp4`,
    });
  };
  const myTier = async (id: string): Promise<MyTierView> =>
    body(await get(id, '/me/tier').expect(200)).data as MyTierView;
  const plansFor = async (id: string): Promise<PlansView> =>
    body(await get(id, '/plans').expect(200)).data as PlansView;
  const rowOf = (id: string) =>
    prisma.makerTier.findUniqueOrThrow({ where: { wawuUserId: id } });

  /** A tier as it was bought before the migration: the OLD count copied onto the row. */
  async function holdAtOldCount(
    tierId: keyof typeof COUNTS,
    opts: {
      published: number;
      extra?: number;
      endsInDays?: number;
      productsIncluded?: number;
    },
  ): Promise<string> {
    const id = await creator();
    const t = config.tiers.find((x) => x.id === tierId)!;
    const until = Date.now() + (opts.endsInDays ?? 200) * DAY;
    await prisma.makerTier.create({
      data: {
        wawuUserId: id,
        tierId,
        activeFrom: new Date(until - t.days * DAY),
        activeUntil: new Date(until),
        productsIncluded: opts.productsIncluded ?? OLD[tierId],
        extraProducts: opts.extra ?? 0,
        pointsIncluded: t.bonusPoints,
        voiceIntroIncluded: false,
      },
    });
    await prisma.creatorState.upsert({
      where: { wawuUserId: id },
      create: { wawuUserId: id, slotsUsed: opts.published },
      update: { slotsUsed: opts.published },
    });
    return id;
  }

  // The people the checks are about, bought at the old counts.
  let founding10: string; // Founding Maker, 10 products up, the old top
  let foundingExtra: string; // Founding Maker, 10 up, with a pack of 5 bought
  let verify3: string; // Verify, 3 of 3
  let plus6: string; // Verify Plus, 6 of 6
  let ended: string; // an ended Founding Maker
  let bigger: string; // a Founding Maker an admin once gave 20

  beforeAll(async () => {
    for (const [k, v] of Object.entries(STORAGE_ENV)) {
      envSnapshot[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        PlansModule,
        StorageModule,
        ContentPieceModule,
        CreatorStateModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    settings = app.get(PlanSettingsService);
    grants = app.get(TierGrantService);
    config = app.get<PlansConfig>(PLANS_CONFIG);
    await openPackRule(
      settings,
      config.tiers.map((t) => t.id),
    );

    // The database as it is before the migration: the three counts SAVED at the old figures (an admin once saved them).
    savedSettings = await prisma.planSetting.findMany({
      where: { key: { in: KEYS } },
      select: { key: true, value: true },
    });
    await prisma.planSetting.deleteMany({ where: { key: { in: KEYS } } });
    for (const t of ['verify', 'plus', 'founding'] as const)
      await prisma.planSetting.create({
        data: { key: `plan.tier.${t}.products`, value: OLD[t] },
      });
    await settings.refresh();

    founding10 = await holdAtOldCount('founding', { published: 10 });
    foundingExtra = await holdAtOldCount('founding', {
      published: 10,
      extra: 5,
    });
    verify3 = await holdAtOldCount('verify', { published: 3 });
    plus6 = await holdAtOldCount('plus', { published: 6 });
    ended = await holdAtOldCount('founding', { published: 4, endsInDays: -3 });
    bigger = await holdAtOldCount('founding', {
      published: 10,
      productsIncluded: 20,
    });
  }, 90_000);

  afterAll(async () => {
    const where = { wawuUserId: { in: people } };
    const mine = await prisma.contentPiece.findMany({
      where: { creatorWawuId: { in: people } },
      select: { id: true },
    });
    await prisma.contentDetail.deleteMany({
      where: { contentId: { in: mine.map((m) => m.id) } },
    });
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: people } },
    });
    for (const sub of people) await purgePersonPoints(prisma, sub);
    await prisma.eventPass.deleteMany({ where });
    await prisma.makerTier.deleteMany({ where });
    await prisma.creatorState.deleteMany({ where });
    await prisma.personBilling.deleteMany({ where });
    await prisma.userProfile.deleteMany({ where });
    await prisma.planSetting.deleteMany({ where: { key: { in: KEYS } } });
    for (const s of savedSettings)
      await prisma.planSetting.create({
        data: { key: s.key, value: s.value as never },
      });
    if (app) {
      await resetPackRule(settings);
      await settings.refresh();
    }
    await app?.close();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the seed a database with no saved setting follows holds 4, 8 and 15', () => {
    const seed = JSON.parse(
      readFileSync(join(__dirname, '../plans.config.json'), 'utf8'),
    ) as { tiers: { id: string; products: number }[] };
    expect(
      Object.fromEntries(seed.tiers.map((t) => [t.id, t.products])),
    ).toEqual(COUNTS);
  });

  describe('before the migration, on a database that holds the old saved counts', () => {
    it('GET /plans still shows 3, 6 and 10 (a saved row keeps the old figure over the seed)', async () => {
      expect(productsOf((await plansFor(founding10)).tiers)).toEqual(OLD);
    });

    it('a Founding Maker with 10 products up is told the limit is reached on the 11th', async () => {
      const res = await publish(founding10).expect(402);
      expect(body(res).reason.code).toBe('product_limit_reached');
      expect((await myTier(founding10)).productsAllowed).toBe(10);
    });

    it('a Verify holder at 3 of 3 is refused a 4th', async () => {
      await publish(verify3).expect(402);
    });
  });

  it('runs the migration on that database', async () => {
    await prisma.$executeRawUnsafe(MIGRATE);
    await settings.refresh();
    const rows = await prisma.planSetting.findMany({
      where: { key: { in: KEYS } },
      orderBy: { key: 'asc' },
      select: { key: true, value: true },
    });
    expect(rows).toEqual([
      { key: 'plan.tier.founding.products', value: 15 },
      { key: 'plan.tier.plus.products', value: 8 },
      { key: 'plan.tier.verify.products', value: 4 },
    ]);
  });

  describe('after the migration', () => {
    it('GET /plans shows 4, 8 and 15, and so does the offer a person with no tier is sent to when they publish', async () => {
      expect(productsOf((await plansFor(founding10)).tiers)).toEqual(COUNTS);
      const fresh = await creator();
      const res = await publish(fresh).expect(402);
      expect(body(res).reason.code).toBe('tier_required');
      expect(
        productsOf((body(res).reason as { tiers: PlanTierView[] }).tiers),
      ).toEqual(COUNTS);
    });

    it('GET /me/tier shows the new count to a person who bought at the old one', async () => {
      expect(await myTier(founding10)).toMatchObject({
        state: 'active',
        productsAllowed: COUNTS.founding,
        productsUsed: 10,
      });
      expect(await myTier(verify3)).toMatchObject({
        productsAllowed: COUNTS.verify,
        productsUsed: 3,
      });
      expect(await myTier(plus6)).toMatchObject({
        productsAllowed: COUNTS.plus,
        productsUsed: 6,
      });
    });

    it('a Founding Maker with 10 products up publishes the 11th, and goes on to 15, where the 16th is refused', async () => {
      await publish(founding10).expect(201);
      expect((await myTier(founding10)).productsUsed).toBe(11);
      for (let n = 12; n <= COUNTS.founding; n += 1)
        await publish(founding10).expect(201);
      expect((await myTier(founding10)).productsUsed).toBe(COUNTS.founding);
      const res = await publish(founding10).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'product_limit_reached',
        productsUsed: COUNTS.founding,
        productsAllowed: COUNTS.founding,
      });
    });

    it('Verify allows a 4th and refuses a 5th; Verify Plus allows a 7th and an 8th and refuses a 9th', async () => {
      await publish(verify3).expect(201);
      await publish(verify3).expect(402);
      await publish(plus6).expect(201);
      await publish(plus6).expect(201);
      await publish(plus6).expect(402);
    });

    it('extra products bought still add on top: 15 + 5 = 20 places for a Founding Maker with a pack', async () => {
      const row = await rowOf(foundingExtra);
      expect(row).toMatchObject({
        productsIncluded: COUNTS.founding,
        extraProducts: 5,
      });
      expect(await myTier(foundingExtra)).toMatchObject({
        productsAllowed: COUNTS.founding + 5,
        productsUsed: 10,
      });
      for (let n = 11; n <= COUNTS.founding + 5; n += 1)
        await publish(foundingExtra).expect(201);
      await publish(foundingExtra).expect(402);
    });

    it('a count is only raised: an ended tier and a tier holding more than the new count are left as they were', async () => {
      expect(await rowOf(ended)).toMatchObject({
        productsIncluded: OLD.founding,
      });
      expect((await myTier(ended)).state).toBe('ended');
      expect(await rowOf(bigger)).toMatchObject({ productsIncluded: 20 });
      expect((await myTier(bigger)).productsAllowed).toBe(20);
    });

    it('a tier bought after the migration copies the new count onto the row', async () => {
      const buyer = await creator();
      const out = await prisma.$transaction((tx) =>
        grants.grant(tx, {
          wawuUserId: buyer,
          tierId: 'founding',
          sourceRef: `counts:${buyer}`,
        }),
      );
      expect(out.granted).toBe(true);
      expect(await rowOf(buyer)).toMatchObject({
        tierId: 'founding',
        productsIncluded: COUNTS.founding,
        extraProducts: 0,
      });
      expect((await myTier(buyer)).productsAllowed).toBe(COUNTS.founding);
    });

    it('an admin who saves a count afterwards still wins for the next buyer, and those who hold a tier keep what they bought', async () => {
      await settings.set(admin, {
        settings: { 'plan.tier.founding.products': 12 },
      });
      expect(productsOf((await plansFor(founding10)).tiers).founding).toBe(12);
      const buyer = await creator();
      await prisma.$transaction((tx) =>
        grants.grant(tx, {
          wawuUserId: buyer,
          tierId: 'founding',
          sourceRef: `counts:admin:${buyer}`,
        }),
      );
      expect((await rowOf(buyer)).productsIncluded).toBe(12);
      // The person who held a tier when the admin saved keeps their own 15.
      expect((await rowOf(foundingExtra)).productsIncluded).toBe(
        COUNTS.founding,
      );
      // Reset: the next buyer reads the seed again, 15.
      await settings.set(admin, {
        settings: { 'plan.tier.founding.products': null },
      });
      const later = await creator();
      await prisma.$transaction((tx) =>
        grants.grant(tx, {
          wawuUserId: later,
          tierId: 'founding',
          sourceRef: `counts:reset:${later}`,
        }),
      );
      expect((await rowOf(later)).productsIncluded).toBe(COUNTS.founding);
    });
  });
});
