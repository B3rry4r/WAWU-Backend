// STORE-SEED (owner, 30 Oct 2026): the store products that sell tiers, points, credits and the upload pack, which nothing
// inserted, so `GET /store/products` listed none of them. The migration 20261221090000_store_seed_products writes them.
// This spec pins the rows (ids, kinds, grants, reference, order) and proves the app sees them: a real HTTP call as a
// creator and as a buyer, on both stores, and a purchase that gets past "unknown product". Run with ports 11020-11027:
//   WAWU_ID_JWKS_URL=http://localhost:11020/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:11020
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_seed_spec?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/test_seed_spec?schema=public';

import type { ChildProcess } from 'child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type {
  StorePlatform,
  StoreProductKind,
} from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PACK_TABLE } from '../../credit-purchase/credit-packs';
import {
  PLANS_CONFIG,
  countIn,
  loadPlansConfig,
  priceIn,
  tierById,
  type PlansConfig,
} from '../../plans/plans-config';
import { packById } from '../../plans/purchases/points-pack-rules';
import { PointsService } from '../../points/points.service';
import { purgePersonPoints } from '../../points/points-purge';
import {
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../test/store/store-standins';
import {
  API,
  BUYER,
  OTHER,
  PEOPLE,
  STAND_IN_CONFIG,
  build,
  codeOf,
  dataOf,
  ensureMockWawuId,
  mintToken,
} from '../../../test/store/store-test-kit';
import { checkProduct, grantsConfigOf, resolveGrants } from '../store-grants';

jest.setTimeout(120_000);

const MIGRATION = join(
  __dirname,
  '../../../prisma/migrations/20261221090000_store_seed_products/migration.sql',
);
const ROLLBACK = join(
  __dirname,
  '../../../prisma/migrations/20261221090000_store_seed_products/rollback.sql',
);

/** The grants the stored shape carries: the four keys every kind has, and `extraProducts` only on the upload pack. */
const grants = (over: Record<string, unknown>) => ({
  packId: null,
  pack: null,
  tierId: null,
  days: null,
  ...over,
});

interface Seed {
  storeProductId: string;
  kind: StoreProductKind;
  title: string;
  grants: Record<string, unknown>;
  referenceKobo: number | null;
  sortOrder: number;
  /** What the store charges in Nigeria, in whole naira: how each id is matched to its plan entry. */
  storeNaira: number;
}

/** The ten products, in the stores under these ids (the same on both). */
const SEEDS: readonly Seed[] = [
  {
    storeProductId: 'wawu.tier.verify',
    kind: 'tier',
    title: 'Verify, 1 year',
    grants: grants({ tierId: 'verify' }),
    referenceKobo: null,
    sortOrder: 101,
    storeNaira: 2999,
  },
  {
    storeProductId: 'wawu.tier.plus',
    kind: 'tier',
    title: 'Verify Plus, 1 year',
    grants: grants({ tierId: 'plus' }),
    referenceKobo: null,
    sortOrder: 102,
    storeNaira: 5999,
  },
  {
    storeProductId: 'wawu.tier.founding',
    kind: 'tier',
    title: 'Founding Maker, 1 year',
    grants: grants({ tierId: 'founding' }),
    referenceKobo: null,
    sortOrder: 103,
    storeNaira: 9999,
  },
  {
    storeProductId: 'wawu.points.s',
    kind: 'points',
    title: 'Points, small pack',
    grants: grants({ packId: 's' }),
    referenceKobo: null,
    sortOrder: 201,
    storeNaira: 1000,
  },
  {
    storeProductId: 'wawu.points.m',
    kind: 'points',
    title: 'Points, medium pack',
    grants: grants({ packId: 'm' }),
    referenceKobo: null,
    sortOrder: 202,
    storeNaira: 2500,
  },
  {
    storeProductId: 'wawu.points.l',
    kind: 'points',
    title: 'Points, large pack',
    grants: grants({ packId: 'l' }),
    referenceKobo: null,
    sortOrder: 203,
    storeNaira: 5000,
  },
  {
    storeProductId: 'wawu.credits.starter',
    kind: 'credits',
    title: 'Credits, starter pack',
    grants: grants({ pack: 'starter' }),
    referenceKobo: 50_000,
    sortOrder: 301,
    storeNaira: 500,
  },
  {
    storeProductId: 'wawu.credits.popular',
    kind: 'credits',
    title: 'Credits, popular pack',
    grants: grants({ pack: 'popular' }),
    referenceKobo: 100_000,
    sortOrder: 302,
    storeNaira: 1000,
  },
  {
    storeProductId: 'wawu.credits.pro',
    kind: 'credits',
    title: 'Credits, pro pack',
    grants: grants({ pack: 'pro' }),
    referenceKobo: 200_000,
    sortOrder: 303,
    storeNaira: 2000,
  },
  {
    storeProductId: 'wawu.more.products.5',
    kind: 'extra_products',
    title: '5 more products',
    grants: grants({ extraProducts: 5 }),
    referenceKobo: null,
    sortOrder: 401,
    storeNaira: 1500,
  },
];

const PLATFORMS: readonly StorePlatform[] = ['android', 'ios'];

describe('STORE-SEED: the migration writes the products the stores sell', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const rollback = readFileSync(ROLLBACK, 'utf8');
  const plans = loadPlansConfig();

  /** The VALUES rows of the migration: id, kind, title, grants, reference, order. */
  const rows = [
    ...sql.matchAll(
      /^\s+\('([^']+)',\s+'([^']+)',\s+'([^']+)',\s+'(\{[^']*\})',\s+(NULL::integer|\d+),\s+(\d+)\)/gm,
    ),
  ].map((m) => ({
    storeProductId: m[1],
    kind: m[2],
    title: m[3],
    grants: JSON.parse(m[4]) as Record<string, unknown>,
    referenceKobo: m[5].startsWith('NULL') ? null : Number(m[5]),
    sortOrder: Number(m[6]),
  }));

  it('has exactly the ten products, with these ids, kinds, titles, grants, references and order', () => {
    expect(rows).toEqual(
      SEEDS.map((s) => ({
        storeProductId: s.storeProductId,
        kind: s.kind,
        title: s.title,
        grants: s.grants,
        referenceKobo: s.referenceKobo,
        sortOrder: s.sortOrder,
      })),
    );
  });

  it('writes each for both stores, active, safe to run again, and leaves the ladder alone', () => {
    expect(sql).toContain(
      `CROSS JOIN (VALUES ('android'::"StorePlatform"), ('ios'::"StorePlatform")) AS p("platform")`,
    );
    expect(sql).toContain(
      'ON CONFLICT ("platform", "storeProductId") DO NOTHING',
    );
    expect(sql).toMatch(/\btrue, s\."sortOrder"/);
    expect(sql).not.toMatch(/wawu\.buy/);
    expect(sql).not.toMatch(/\bDELETE\b|\bUPDATE\b|\bDROP\b/i);
  });

  it('is written for a person to read: no em-dash in the titles or the notes', () => {
    for (const r of rows) expect(r.title).not.toContain('—');
    expect(sql).not.toContain('—');
    expect(rollback).not.toContain('—');
  });

  it('is the shape the admin create route stores: each row passes checkProduct and comes back unchanged', () => {
    for (const r of rows) {
      const checked = checkProduct(
        r.kind as StoreProductKind,
        grantsConfigOf(r.grants),
        r.referenceKobo,
        plans,
      );
      expect({
        grants: checked.grants,
        referenceKobo: checked.referenceKobo,
      }).toEqual({ grants: r.grants, referenceKobo: r.referenceKobo });
    }
  });

  it('matches every store id to its plan entry by price, and invents no count', () => {
    const naira = (kobo: number) => kobo / 100;
    for (const s of SEEDS) {
      const g = s.grants as {
        packId: string | null;
        pack: keyof typeof PACK_TABLE | null;
        tierId: string | null;
        extraProducts?: number;
      };
      if (s.kind === 'tier') {
        const tier = tierById(plans, g.tierId ?? '');
        expect(tier).not.toBeNull();
        expect(naira(priceIn(tier!.price, 'NGN'))).toBe(s.storeNaira);
        expect(tier!.days).toBe(365);
      } else if (s.kind === 'points') {
        const pack = packById(plans, g.packId ?? '');
        expect(pack).not.toBeNull();
        expect(naira(priceIn(pack!.price, 'NGN'))).toBe(s.storeNaira);
      } else if (s.kind === 'credits') {
        expect(PACK_TABLE[g.pack!].amount).toBe(s.storeNaira);
        expect(s.referenceKobo).toBe(PACK_TABLE[g.pack!].amount * 100);
      } else {
        expect(plans.extraProducts.count).toBe(g.extraProducts);
        expect(naira(plans.extraProducts.price.kobo)).toBe(s.storeNaira);
      }
    }
  });

  it('gives what the plan says: points 1,000 / 2,750 / 6,000, credits 50 / 120 / 300, a year of each tier, 5 more products', () => {
    const give = (id: string) => {
      const r = rows.find((x) => x.storeProductId === id)!;
      return resolveGrants(
        r.kind as StoreProductKind,
        grantsConfigOf(r.grants),
        plans,
      );
    };
    expect(give('wawu.points.s').points).toBe(1000);
    expect(give('wawu.points.m').points).toBe(2750);
    expect(give('wawu.points.l').points).toBe(6000);
    expect(
      ['starter', 'popular', 'pro'].map(
        (p) => give(`wawu.credits.${p}`).credits,
      ),
    ).toEqual([50, 120, 300]);
    for (const t of ['verify', 'plus', 'founding'])
      expect(give(`wawu.tier.${t}`)).toMatchObject({ tierId: t, days: 365 });
    expect(give('wawu.more.products.5').extraProducts).toBe(5);
  });

  it('has a rollback that keeps every row a purchase or an intent names, or an admin wrote, and never touches the ladder', () => {
    expect(rollback).toContain('"updatedBy" IS NULL');
    expect(rollback).toContain('FROM "StorePurchase"');
    expect(rollback).toContain('FROM "StorePurchaseIntent"');
    expect(rollback).toContain(`sp."kind"::text <> 'buy'`);
    for (const s of SEEDS) expect(rollback).toContain(`'${s.storeProductId}'`);
  });
});

describe('STORE-SEED: the app sees the products (stand-in stores)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let plans: PlansConfig;
  let points: PointsService;
  let mock: ChildProcess | undefined;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  /** A buyer account (BUYER) and a creator account (OTHER). */
  let buyer: string;
  let creator: string;
  const http = () => request(app.getHttpServer() as Server);
  const as = (token: string) => ({
    get: (url: string) =>
      http().get(`${API}${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  /** Runs the migration's statement as the deploy does. */
  const seed = async () => {
    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
  };

  async function wipe(): Promise<void> {
    for (const who of PEOPLE) await purgePersonPoints(prisma, who);
    await prisma.storeNotification.deleteMany({});
    await prisma.makerPurchase.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.eventPass.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.storePurchase.deleteMany({});
    await prisma.storeSubscription.deleteMany({});
  }

  beforeAll(async () => {
    mock = await ensureMockWawuId();
    buyer = mintToken(BUYER);
    creator = mintToken(OTHER);
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    plans = moduleRef.get<PlansConfig>(PLANS_CONFIG);
    points = moduleRef.get(PointsService);
    await prisma.userProfile.createMany({
      data: [
        { wawuUserId: BUYER, accountType: 'user' },
        { wawuUserId: OTHER, accountType: 'creator' },
      ],
    });
    await wipe();
    await prisma.storeProduct.deleteMany({});
    await prisma.storePlatformSetting.deleteMany({});
    await seed();
  });

  afterAll(async () => {
    if (prisma) {
      await wipe();
      await prisma.storeAccountToken.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
      await prisma.storeProduct.deleteMany({});
      await prisma.storePlatformSetting.deleteMany({});
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
    }
    await app?.close();
    mock?.kill();
  });

  it('wrote ten active products for each store, with the stored grants, and nothing else', async () => {
    const stored = await prisma.storeProduct.findMany({
      orderBy: [{ platform: 'asc' }, { sortOrder: 'asc' }],
    });
    expect(stored).toHaveLength(20);
    for (const platform of PLATFORMS) {
      const mine = stored.filter((r) => r.platform === platform);
      expect(
        mine.map((r) => ({
          storeProductId: r.storeProductId,
          kind: r.kind,
          title: r.title,
          grants: r.grants,
          referenceKobo: r.referenceKobo,
          storePriceKobo: r.storePriceKobo,
          sortOrder: r.sortOrder,
          active: r.active,
          updatedBy: r.updatedBy,
        })),
      ).toEqual(
        SEEDS.map((s) => ({
          storeProductId: s.storeProductId,
          kind: s.kind,
          title: s.title,
          grants: s.grants,
          referenceKobo: s.referenceKobo,
          storePriceKobo: null,
          sortOrder: s.sortOrder,
          active: true,
          updatedBy: null,
        })),
      );
    }
  });

  for (const [who, account] of [
    ['a buyer', 'buyer'],
    ['a creator', 'creator'],
  ] as const) {
    for (const platform of PLATFORMS) {
      it(`GET /store/products?platform=${platform} as ${who}: the tiers, points, credits and the upload pack, each with what it gives`, async () => {
        const token = account === 'buyer' ? buyer : creator;
        const res = await as(token)
          .get(`/store/products?platform=${platform}`)
          .expect(200);
        const list = dataOf<{
          platform: string;
          available: boolean;
          reason: null;
          products: Array<{
            storeProductId: string;
            kind: string;
            title: string;
            subscription: boolean;
            platform: string;
            grants: Record<string, unknown>;
          }>;
        }>(res);
        expect(list).toMatchObject({ platform, available: true, reason: null });
        expect(list.products.map((p) => p.storeProductId)).toEqual(
          SEEDS.map((s) => s.storeProductId),
        );
        const by = (id: string) =>
          list.products.find((p) => p.storeProductId === id)!;
        for (const s of SEEDS) {
          expect(by(s.storeProductId)).toMatchObject({
            platform,
            kind: s.kind,
            title: s.title,
            subscription: s.kind === 'tier',
          });
        }
        for (const t of plans.tiers)
          expect(by(`wawu.tier.${t.id}`).grants).toEqual({
            points: null,
            credits: null,
            tierId: t.id,
            days: t.days,
          });
        for (const p of plans.packs)
          expect(by(`wawu.points.${p.id}`).grants).toEqual({
            points: countIn(p.points, 'NGN'),
            credits: null,
            tierId: null,
            days: null,
          });
        for (const [pack, t] of Object.entries(PACK_TABLE))
          expect(by(`wawu.credits.${pack}`).grants).toEqual({
            points: null,
            credits: t.credits,
            tierId: null,
            days: null,
          });
        expect(by('wawu.more.products.5').grants).toEqual({
          points: null,
          credits: null,
          tierId: null,
          days: null,
          extraProducts: plans.extraProducts.count,
        });
        // The app draws the store's own price; the Hub sends none.
        expect(JSON.stringify(list)).not.toMatch(/price|kobo/i);
      });
    }
  }

  it('running the migration again changes nothing, and a row an admin made first is left as it is', async () => {
    await seed();
    await seed();
    expect(await prisma.storeProduct.count()).toBe(20);
    const id = { platform: 'ios' as const, storeProductId: 'wawu.points.m' };
    await prisma.storeProduct.update({
      where: { platform_storeProductId: id },
      data: { title: 'Admin title', active: false, updatedBy: 'an-admin' },
    });
    await prisma.storeProduct.delete({
      where: {
        platform_storeProductId: { ...id, storeProductId: 'wawu.points.l' },
      },
    });
    await seed();
    expect(await prisma.storeProduct.count()).toBe(20);
    expect(
      await prisma.storeProduct.findUniqueOrThrow({
        where: { platform_storeProductId: id },
      }),
    ).toMatchObject({
      title: 'Admin title',
      active: false,
      updatedBy: 'an-admin',
    });
    expect(
      await prisma.storeProduct.findUniqueOrThrow({
        where: {
          platform_storeProductId: { ...id, storeProductId: 'wawu.points.l' },
        },
      }),
    ).toMatchObject({ title: 'Points, large pack', active: true });
    await prisma.storeProduct.update({
      where: { platform_storeProductId: id },
      data: {
        title: 'Points, medium pack',
        active: true,
        updatedBy: null,
      },
    });
  });

  it('a points product id gets past "unknown product": it is checked with the store, and an unknown id is still refused', async () => {
    // No such purchase at the (stand-in) store: refused for that, not for the product.
    const unverified = await as(buyer).post('/store/purchases', {
      platform: 'android',
      productId: 'wawu.points.s',
      purchaseToken: 'no-such-token',
    });
    expect(unverified.status).toBe(422);
    expect(codeOf(unverified)).toBe('store_purchase_invalid');
    const unknown = await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: 'wawu.points.xl',
        purchaseToken: 'no-such-token',
      })
      .expect(404);
    expect(codeOf(unknown)).toBe('store_product_unknown');
  });

  it('a points pack bought through the store is granted whole: Google says it was paid, the buyer holds the points', async () => {
    const accountToken = dataOf<{ accountToken: string }>(
      await as(buyer).get('/store/products?platform=android').expect(200),
    ).accountToken;
    google.oneTime.set(
      'tok-seed-points-m',
      verified({
        platform: 'android',
        storeProductId: 'wawu.points.m',
        storeTransactionId: 'GPA.seed.points.m',
        needsAcknowledge: true,
        accountToken,
      }),
    );
    const res = await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: 'wawu.points.m',
        purchaseToken: 'tok-seed-points-m',
      })
      .expect(201);
    const pack = packById(plans, 'm')!;
    expect(
      dataOf<{ status: string; grant: { points: number } }>(res),
    ).toMatchObject({
      status: 'granted',
      grant: { points: countIn(pack.points, 'NGN') },
    });
    expect(await points.balanceOf(BUYER)).toBe(countIn(pack.points, 'NGN'));
    expect(google.consumed).toEqual(['tok-seed-points-m']);
  });

  it('a tier bought through the store is granted: the buyer holds a year of it', async () => {
    const accountToken = dataOf<{ accountToken: string }>(
      await as(creator).get('/store/products?platform=android').expect(200),
    ).accountToken;
    google.subscriptions.set(
      'tok-seed-tier-plus',
      verified({
        platform: 'android',
        storeProductId: 'wawu.tier.plus',
        storeTransactionId: 'GPA.seed.tier.plus..0',
        subscriptionKey: 'tok-seed-tier-plus',
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
        needsAcknowledge: true,
        accountToken,
      }),
    );
    const res = await as(creator)
      .post('/store/purchases', {
        platform: 'android',
        productId: 'wawu.tier.plus',
        purchaseToken: 'tok-seed-tier-plus',
      })
      .expect(201);
    expect(dataOf<{ grant: { tierId: string } }>(res).grant.tierId).toBe(
      'plus',
    );
    const held = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: OTHER },
    });
    expect(held.tierId).toBe('plus');
    expect(
      Math.round(
        (held.activeUntil.getTime() - held.activeFrom.getTime()) / 86_400_000,
      ),
    ).toBe(tierById(plans, 'plus')!.days);
  });
});
