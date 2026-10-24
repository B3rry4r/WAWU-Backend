// Contract tests for task IAP-01 (R-86): buying through Google Play and the App
// Store. Real HTTP, a real database, real guards and the real grant code; the two
// stores' servers are stand-ins (store-standins.ts). Run with ports 8520-8527:
//   WAWU_ID_JWKS_URL=http://localhost:8520/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:8520
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/b27iap_test?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/b27iap_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminTokenService } from '../../admin/auth/admin-token.service';
import { CommunityPassRemoval } from '../../community/pass/community-pass-removal.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PLANS_CONFIG,
  countIn,
  type PlansConfig,
} from '../../plans/plans-config';
import { PointsService } from '../../points/points.service';
import { purgePersonPoints } from '../../points/points-purge';
import { APP_STORE_CLIENT, GOOGLE_PLAY_CLIENT } from '../clients/store-clients';
import {
  loadStoreConfig,
  STORE_CONFIG,
  type StoreConfig,
} from '../store-config';
import { StoreModule } from '../store.module';
import {
  StandInAppStore,
  StandInGooglePlay,
  inDays,
  verified,
} from './store-standins';

jest.setTimeout(120_000);

type Env<T> = { statusCode: number; data: T; reason?: { code: string } };
const dataOf = <T>(res: { body: unknown }): T => (res.body as Env<T>).data;
const codeOf = (res: { body: unknown }): string | undefined =>
  (res.body as Env<unknown>).reason?.code;

const BUYER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const HOST = '00000000-0000-4000-8000-000000000003';
const PEOPLE = [BUYER, OTHER, HOST];

const PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '8520';
const MOCK = `http://localhost:${PORT}`;
const API = '/api/hub';

async function healthy(url: string, ms = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const FAKE_CONFIG: StoreConfig = {
  // Non-null means "the Hub holds this store's credentials"; the clients are stand-ins.
  google: {
    packageName: 'africa.wawu.test',
    serviceAccount: { client_email: 'x', private_key: 'x', token_uri: 'x' },
    apiBase: 'x',
    pubsubAudience: 'x',
    pubsubServiceAccountEmail: 'x',
    jwksUrl: 'x',
  },
  apple: {
    bundleId: 'africa.wawu.test',
    issuerId: 'x',
    keyId: 'x',
    privateKey: 'x',
    environment: 'Sandbox',
    rootCertificates: [],
    appAppleId: null,
  },
  feeBps: { android: 1500, ios: 3000 },
};

async function build(
  config: StoreConfig,
  google: StandInGooglePlay | null,
  apple: StandInAppStore | null,
): Promise<{ app: INestApplication; moduleRef: TestingModule }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      StoreModule,
    ],
  })
    .overrideProvider(STORE_CONFIG)
    .useValue(config)
    .overrideProvider(GOOGLE_PLAY_CLIENT)
    .useValue(google)
    .overrideProvider(APP_STORE_CLIENT)
    .useValue(apple)
    .compile();
  const app = moduleRef.createNestApplication({
    logger: process.env.IAP_LOG ? ['error'] : false,
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
  await app.init();
  return { app, moduleRef };
}

describe('IAP-01: nothing is asked of a store the Hub has no keys for', () => {
  let app: INestApplication;
  let mock: ChildProcess | undefined;
  let token: string;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    if (!(await healthy(`${MOCK}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: PORT },
        stdio: 'ignore',
      });
      if (!(await healthy(`${MOCK}/health`)))
        throw new Error('mock-wawu-id not healthy');
    }
    token = await login('user@test.wawu.dev');
    ({ app } = await build(loadStoreConfig({}), null, null));
  });
  afterAll(async () => {
    await app?.close();
    mock?.kill();
  });

  it('GET /store/products says the store is not configured, and lists nothing', async () => {
    for (const platform of ['android', 'ios']) {
      const res = await http()
        .get(`${API}/store/products?platform=${platform}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(dataOf(res)).toEqual({
        platform,
        available: false,
        reason: 'store_not_configured',
        products: [],
      });
    }
  });

  it('POST /store/purchases answers store_not_configured (503) plainly', async () => {
    const res = await http()
      .post(`${API}/store/purchases`)
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'android', productId: 'x', purchaseToken: 't' })
      .expect(503);
    expect(codeOf(res)).toBe('store_not_configured');
    expect((res.body as { message: string }).message).not.toContain('—');
  });

  it('both webhooks answer store_not_configured (503) and need no user token', async () => {
    const g = await http()
      .post(`${API}/webhooks/google-play`)
      .send({})
      .expect(503);
    expect(codeOf(g)).toBe('store_not_configured');
    const a = await http()
      .post(`${API}/webhooks/app-store`)
      .send({})
      .expect(503);
    expect(codeOf(a)).toBe('store_not_configured');
  });

  it('the app routes need a token; the admin routes need an admin', async () => {
    await http().get(`${API}/store/products?platform=ios`).expect(401);
    await http().post(`${API}/store/purchases`).send({}).expect(401);
    await http().get(`${API}/admin/store/products`).expect(401);
  });

  it('loadStoreConfig: a store is null until everything it needs is set; the cut defaults to 15%', () => {
    expect(loadStoreConfig({})).toEqual({
      google: null,
      apple: null,
      feeBps: { android: 1500, ios: 1500 },
    });
    expect(
      loadStoreConfig({ GOOGLE_PLAY_PACKAGE_NAME: 'a' }).google,
    ).toBeNull();
    const sa = JSON.stringify({ client_email: 'a@b', private_key: 'k' });
    const g = loadStoreConfig({
      GOOGLE_PLAY_PACKAGE_NAME: 'a',
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: Buffer.from(sa).toString('base64'),
      STORE_FEE_BPS_IOS: '3000',
    });
    expect(g.google?.serviceAccount.token_uri).toBe(
      'https://oauth2.googleapis.com/token',
    );
    expect(g.feeBps.ios).toBe(3000);
    expect(() => loadStoreConfig({ STORE_FEE_BPS_ANDROID: '15%' })).toThrow();
    // Apple needs the keys, the environment AND at least one root certificate.
    const apple = {
      APPLE_BUNDLE_ID: 'b',
      APPLE_ISSUER_ID: 'i',
      APPLE_KEY_ID: 'k',
      APPLE_PRIVATE_KEY: 'p',
      APPLE_ENVIRONMENT: 'Sandbox',
    };
    expect(loadStoreConfig(apple).apple).toBeNull();
    const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    expect(
      loadStoreConfig({ ...apple, APPLE_ROOT_CERTIFICATES: pem }).apple
        ?.rootCertificates,
    ).toHaveLength(1);
    expect(
      loadStoreConfig({
        ...apple,
        APPLE_ENVIRONMENT: 'Production',
        APPLE_ROOT_CERTIFICATES: pem,
      }).apple,
    ).toBeNull();
  });
});

describe('IAP-01: buying through the stores (stand-in stores)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let plans: PlansConfig;
  let points: PointsService;
  let mock: ChildProcess | undefined;
  let buyer: string;
  let other: string;
  let host: string;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  const adminIds: string[] = [];
  const adminToken: Partial<Record<AdminRole, string>> = {};
  const communityIds: string[] = [];

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
  const admin = (role: AdminRole) => ({
    get: (url: string) =>
      http()
        .get(`${API}${url}`)
        .set('Authorization', `Bearer ${adminToken[role]}`),
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${adminToken[role]}`)
        .send(body),
    patch: (url: string, body: object) =>
      http()
        .patch(`${API}${url}`)
        .set('Authorization', `Bearer ${adminToken[role]}`)
        .send(body),
  });
  const uid = () => randomUUID().slice(0, 8);

  /** The product map the tests sell from. */
  let packId: string;
  let tierId: string;
  const P = {
    android: {
      points: 'wawu_points_s',
      credits: 'wawu_credits_popular',
      tier: 'wawu_tier_x',
      pass: 'wawu_pass_30',
    },
    ios: {
      points: 'wawu.points.s',
      credits: 'wawu.credits.popular',
      tier: 'wawu.tier.x',
      pass: 'wawu.pass.30',
    },
  } as const;
  const productRows = () =>
    [
      {
        platform: 'android',
        kind: 'points',
        storeProductId: P.android.points,
        grants: { packId },
        referenceKobo: null,
      },
      {
        platform: 'android',
        kind: 'credits',
        storeProductId: P.android.credits,
        grants: { pack: 'popular' },
        referenceKobo: 100_000,
      },
      {
        platform: 'android',
        kind: 'tier',
        storeProductId: P.android.tier,
        grants: { tierId },
        referenceKobo: null,
      },
      {
        platform: 'android',
        kind: 'pass',
        storeProductId: P.android.pass,
        grants: { days: 30 },
        referenceKobo: 200_000,
      },
      {
        platform: 'ios',
        kind: 'points',
        storeProductId: P.ios.points,
        grants: { packId },
        referenceKobo: null,
      },
      {
        platform: 'ios',
        kind: 'credits',
        storeProductId: P.ios.credits,
        grants: { pack: 'popular' },
        referenceKobo: 100_000,
      },
      {
        platform: 'ios',
        kind: 'tier',
        storeProductId: P.ios.tier,
        grants: { tierId },
        referenceKobo: null,
      },
      {
        platform: 'ios',
        kind: 'pass',
        storeProductId: P.ios.pass,
        grants: { days: 30 },
        referenceKobo: 200_000,
      },
    ] as const;

  async function room(
    hostId: string,
    passKobo: number | null = 150_000,
  ): Promise<string> {
    const c = await prisma.community.create({
      data: {
        name: `IAP room ${uid()}`,
        description: 'A private room.',
        hostWawuId: hostId,
        kind: 'private',
        ...(passKobo !== null
          ? { passPrice: { create: { priceKobo: BigInt(passKobo) } } }
          : {}),
      },
    });
    communityIds.push(c.id);
    return c.id;
  }

  async function wipe(): Promise<void> {
    for (const who of PEOPLE) await purgePersonPoints(prisma, who);
    await prisma.storeNotification.deleteMany({});
    await prisma.creditPurchase.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.creditsState.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.communityPass.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.communityMembership.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
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
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'iap01-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'iap01-admin-refresh-secret-0123456789abcd',
    }))
      process.env[k] = v;
    if (!(await healthy(`${MOCK}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: PORT },
        stdio: 'ignore',
      });
      if (!(await healthy(`${MOCK}/health`)))
        throw new Error('mock-wawu-id not healthy');
    }
    buyer = await login('user@test.wawu.dev');
    other = await login('creator-basic@test.wawu.dev');
    host = await login('creator-pro@test.wawu.dev');
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(FAKE_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    plans = moduleRef.get<PlansConfig>(PLANS_CONFIG);
    points = moduleRef.get(PointsService);
    packId = plans.packs[0].id;
    tierId = plans.tiers[0].id;
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
      AdminRole.reviewer,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const row = await prisma.adminUser.create({
        data: {
          id,
          email: `iap01-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'x',
          name: `IAP ${role}`,
          role,
        },
      });
      adminToken[role] = issuer.issuePair(row).accessToken;
    }
    await wipe();
    await prisma.storeProduct.deleteMany({});
    await prisma.storePlatformSetting.deleteMany({});
    await prisma.storeProduct.createMany({
      data: productRows().map((r, i) => ({
        platform: r.platform,
        kind: r.kind,
        storeProductId: r.storeProductId,
        title: `${r.kind} ${r.platform}`,
        grants: r.grants,
        referenceKobo: r.referenceKobo,
        sortOrder: i,
      })),
    });
  });

  afterAll(async () => {
    if (prisma) {
      await wipe();
      await prisma.storeProduct.deleteMany({});
      await prisma.storePlatformSetting.deleteMany({});
      await prisma.communityPassPrice.deleteMany({
        where: { communityId: { in: communityIds } },
      });
      await prisma.community.deleteMany({
        where: { id: { in: communityIds } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    await app?.close();
    mock?.kill();
  });

  beforeEach(async () => {
    await wipe();
    await prisma.storePlatformSetting.deleteMany({});
    google.oneTime.clear();
    google.subscriptions.clear();
    google.consumed.length = 0;
    google.acknowledged.length = 0;
    google.unreachable = false;
    google.failAcknowledge = false;
    apple.transactions.clear();
    apple.notifications.clear();
    apple.unreachable = false;
  });

  // ------------------------------------------------------------------ products

  it('GET /store/products lists the active products with what each gives and no price', async () => {
    await prisma.storeProduct.update({
      where: {
        platform_storeProductId: {
          platform: 'android',
          storeProductId: P.android.pass,
        },
      },
      data: { active: false },
    });
    try {
      const res = await as(buyer)
        .get('/store/products?platform=android')
        .expect(200);
      const list = dataOf<{
        available: boolean;
        reason: null;
        products: Array<Record<string, unknown>>;
      }>(res);
      expect(list.available).toBe(true);
      expect(list.products.map((p) => p.storeProductId)).toEqual([
        P.android.points,
        P.android.credits,
        P.android.tier,
      ]);
      expect(list.products[0]).toMatchObject({
        kind: 'points',
        subscription: false,
        grants: {
          points: countIn(plans.packs[0].points, 'NGN'),
          credits: null,
          tierId: null,
          days: null,
        },
      });
      expect(list.products[1]).toMatchObject({
        kind: 'credits',
        grants: { credits: 120 },
      });
      expect(list.products[2]).toMatchObject({
        kind: 'tier',
        subscription: true,
        grants: { tierId },
      });
      expect(JSON.stringify(list)).not.toMatch(/price|kobo/i);
      await as(buyer).get('/store/products?platform=windows').expect(400);
    } finally {
      await prisma.storeProduct.update({
        where: {
          platform_storeProductId: {
            platform: 'android',
            storeProductId: P.android.pass,
          },
        },
        data: { active: true },
      });
    }
  });

  // ------------------------------------------------------------- points packs

  const packTokens = (token: string, orderId = `GPA.${uid()}`) => {
    google.oneTime.set(
      token,
      verified({
        platform: 'android',
        storeProductId: P.android.points,
        storeTransactionId: orderId,
        needsAcknowledge: true,
      }),
    );
    return orderId;
  };

  it('a points pack is checked with Google, granted once as one lot, and consumed', async () => {
    const orderId = packTokens('tok-points');
    const res = await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.points,
        purchaseToken: 'tok-points',
      })
      .expect(201);
    const view = dataOf<{
      id: string;
      status: string;
      alreadyGranted: boolean;
      grant: { points: number };
    }>(res);
    const expected = countIn(plans.packs[0].points, 'NGN');
    expect(view).toMatchObject({
      status: 'granted',
      alreadyGranted: false,
      grant: { points: expected },
    });
    const lot = await prisma.pointLot.findUniqueOrThrow({
      where: {
        source_sourceRef: { source: 'pack', sourceRef: `store:${view.id}` },
      },
    });
    expect(lot).toMatchObject({
      wawuUserId: BUYER,
      quantity: expected,
      remaining: expected,
    });
    expect(await points.balanceOf(BUYER)).toBe(expected);
    expect(google.consumed).toEqual(['tok-points']);
    const row = await prisma.storePurchase.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row).toMatchObject({
      storeTransactionId: orderId,
      kind: 'points',
      storeFeeBps: 1500,
      referenceKobo: null,
      netKobo: null,
    });
  });

  it('the same purchase again, a restore and a race give exactly once', async () => {
    packTokens('tok-race');
    const body = {
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'tok-race',
    };
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => as(buyer).post('/store/purchases', body)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201, 201, 201, 201, 201,
    ]);
    const views = results.map((r) =>
      dataOf<{ id: string; alreadyGranted: boolean }>(r),
    );
    expect(new Set(views.map((v) => v.id)).size).toBe(1);
    expect(views.filter((v) => !v.alreadyGranted)).toHaveLength(1);
    expect(await prisma.storePurchase.count()).toBe(1);
    expect(
      await prisma.pointLot.count({
        where: { wawuUserId: BUYER, source: 'pack' },
      }),
    ).toBe(1);
    expect(await points.balanceOf(BUYER)).toBe(
      countIn(plans.packs[0].points, 'NGN'),
    );
  });

  it('a purchase already used on another account gives the second account nothing', async () => {
    packTokens('tok-shared');
    const body = {
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'tok-shared',
    };
    await as(buyer).post('/store/purchases', body).expect(201);
    const res = await as(other).post('/store/purchases', body).expect(409);
    expect(codeOf(res)).toBe('store_purchase_taken');
    expect(await points.balanceOf(OTHER)).toBe(0);
  });

  it('a Google acknowledgement that fails does not undo the grant, and the next ask tries again', async () => {
    packTokens('tok-ack');
    google.failAcknowledge = true;
    const body = {
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'tok-ack',
    };
    await as(buyer).post('/store/purchases', body).expect(201);
    expect(google.consumed).toEqual([]);
    expect(await points.balanceOf(BUYER)).toBeGreaterThan(0);
    google.failAcknowledge = false;
    const again = await as(buyer).post('/store/purchases', body).expect(201);
    expect(dataOf<{ alreadyGranted: boolean }>(again).alreadyGranted).toBe(
      true,
    );
    expect(google.consumed).toEqual(['tok-ack']);
  });

  it('refuses what the store does not vouch for, and grants nothing', async () => {
    const buy = (b: object) => as(buyer).post('/store/purchases', b);
    // a product that is not in the map
    let res = await buy({
      platform: 'android',
      productId: 'nope',
      purchaseToken: 't',
    }).expect(404);
    expect(codeOf(res)).toBe('store_product_unknown');
    // a token the store does not know
    res = await buy({
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'unknown',
    }).expect(422);
    expect(codeOf(res)).toBe('store_purchase_invalid');
    // the store says it is pending
    google.oneTime.set(
      'tok-pending',
      verified({
        platform: 'android',
        storeProductId: P.android.points,
        storeTransactionId: 'O1',
        state: 'pending',
      }),
    );
    res = await buy({
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'tok-pending',
    }).expect(409);
    expect(codeOf(res)).toBe('store_purchase_pending');
    // cancelled or refunded in the store
    google.oneTime.set(
      'tok-cancelled',
      verified({
        platform: 'android',
        storeProductId: P.android.points,
        storeTransactionId: 'O2',
        state: 'cancelled',
      }),
    );
    res = await buy({
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'tok-cancelled',
    }).expect(422);
    expect(codeOf(res)).toBe('store_purchase_invalid');
    // the token is for another product than the one named
    google.oneTime.set(
      'tok-other',
      verified({
        platform: 'android',
        storeProductId: P.android.points,
        storeTransactionId: 'O3',
      }),
    );
    res = await buy({
      platform: 'android',
      productId: P.android.credits,
      purchaseToken: 'tok-other',
    }).expect(422);
    // the store cannot be reached: a plain, repeatable 503
    google.unreachable = true;
    res = await buy({
      platform: 'android',
      productId: P.android.points,
      purchaseToken: 'tok-pending',
    }).expect(503);
    expect(codeOf(res)).toBe('store_unreachable');
    google.unreachable = false;
    // the receipt itself is missing
    res = await buy({
      platform: 'android',
      productId: P.android.points,
    }).expect(400);
    expect(codeOf(res)).toBe('store_receipt_missing');
    res = await buy({ platform: 'ios', productId: P.ios.points }).expect(400);
    expect(codeOf(res)).toBe('store_receipt_missing');
    await buy({
      platform: 'ios',
      productId: P.ios.points,
      transactionId: 'abc',
    }).expect(400);
    expect(await prisma.storePurchase.count()).toBe(0);
    expect(await points.balanceOf(BUYER)).toBe(0);
  });

  it('an admin switch off stops buying (409) and a missing switch row means on', async () => {
    packTokens('tok-off');
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: false })
      .expect(200);
    const off = await as(buyer)
      .get('/store/products?platform=android')
      .expect(200);
    expect(dataOf(off)).toMatchObject({
      available: false,
      reason: 'store_disabled',
      products: [],
    });
    const res = await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.points,
        purchaseToken: 'tok-off',
      })
      .expect(409);
    expect(codeOf(res)).toBe('store_disabled');
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: true })
      .expect(200);
    await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.points,
        purchaseToken: 'tok-off',
      })
      .expect(201);
  });

  // ------------------------------------------------------------------ credits

  it("a credits pack adds the credits and opens a lot whose gross is WAWU's net after the store's share", async () => {
    google.oneTime.set(
      'tok-cr',
      verified({
        platform: 'android',
        storeProductId: P.android.credits,
        storeTransactionId: 'GPA.cr1',
        needsAcknowledge: true,
      }),
    );
    const res = await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.credits,
        purchaseToken: 'tok-cr',
      })
      .expect(201);
    const view = dataOf<{ id: string; grant: { credits: number } }>(res);
    expect(view.grant.credits).toBe(120);
    expect(
      (
        await prisma.creditsState.findUniqueOrThrow({
          where: { userWawuId: BUYER },
        })
      ).creditBalance,
    ).toBe(120);
    const purchase = await prisma.creditPurchase.findUniqueOrThrow({
      where: { storePurchaseId: view.id },
      include: { lot: true },
    });
    expect(purchase).toMatchObject({
      status: 'completed',
      flutterwaveTxRef: `store:${view.id}`,
      creditsGranted: 120,
    });
    // 15% of 100000 kobo is the store's: WAWU's net, and so the lot's gross, is 85000.
    expect(purchase.lot).toMatchObject({
      creditsGranted: 120,
      creditsRemaining: 120,
      grossKobo: 85_000,
    });
    const row = await prisma.storePurchase.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row).toMatchObject({
      referenceKobo: 100_000,
      storeFeeBps: 1500,
      netKobo: 85_000,
      creatorShareKobo: null,
    });
    expect(google.consumed).toEqual(['tok-cr']);
  });

  it("the cut is per store: the App Store's 30% leaves 70000, and an admin cut overrides the config", async () => {
    apple.transactions.set(
      '7001',
      verified({
        platform: 'ios',
        storeProductId: P.ios.credits,
        storeTransactionId: '7001',
      }),
    );
    const res = await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: P.ios.credits,
        transactionId: '7001',
      })
      .expect(201);
    const id = dataOf<{ id: string }>(res).id;
    expect(
      (
        await prisma.creditPurchase.findUniqueOrThrow({
          where: { storePurchaseId: id },
          include: { lot: true },
        })
      ).lot?.grossKobo,
    ).toBe(70_000);
    const set = await admin(AdminRole.finance)
      .patch('/admin/store/platforms/ios', { storeFeeBps: 1000 })
      .expect(200);
    expect(dataOf(set)).toMatchObject({
      platform: 'ios',
      storeFeeBps: 1000,
      storeFeeOverridden: true,
      configured: true,
      enabled: true,
    });
    apple.transactions.set(
      '7002',
      verified({
        platform: 'ios',
        storeProductId: P.ios.credits,
        storeTransactionId: '7002',
      }),
    );
    const second = await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: P.ios.credits,
        transactionId: '7002',
      })
      .expect(201);
    expect(
      (
        await prisma.storePurchase.findUniqueOrThrow({
          where: { id: dataOf<{ id: string }>(second).id },
        })
      ).netKobo,
    ).toBe(90_000);
    const back = await admin(AdminRole.finance)
      .patch('/admin/store/platforms/ios', { storeFeeBps: -1 })
      .expect(200);
    expect(dataOf(back)).toMatchObject({
      storeFeeBps: 3000,
      storeFeeOverridden: false,
    });
  });

  // ------------------------------------------------------------------- tiers

  const sub = (token: string, productId: string, order: string, days = 30) =>
    google.subscriptions.set(
      token,
      verified({
        platform: 'android',
        storeProductId: productId,
        storeTransactionId: order,
        subscriptionKey: token,
        expiresAt: inDays(days),
        needsAcknowledge: true,
      }),
    );

  it('a tier is granted through the tier grant code: the tier, its bonus points, a purchase record, and acknowledged', async () => {
    const tier = plans.tiers[0];
    sub('sub-tier', P.android.tier, 'GPA.t..0');
    const res = await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.tier,
        purchaseToken: 'sub-tier',
      })
      .expect(201);
    const view = dataOf<{
      id: string;
      grant: { tierId: string; until: string };
    }>(res);
    expect(view.grant.tierId).toBe(tierId);
    const held = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: BUYER },
    });
    expect(held.tierId).toBe(tierId);
    const days = Math.round(
      (held.activeUntil.getTime() - held.activeFrom.getTime()) / 86_400_000,
    );
    expect(days).toBe(tier.days);
    expect(held.activeUntil.toISOString()).toBe(view.grant.until);
    expect(
      await prisma.makerPurchase.findUniqueOrThrow({
        where: { paymentRef: `store:${view.id}` },
      }),
    ).toMatchObject({
      method: 'store',
      kind: 'tier',
      wawuUserId: BUYER,
    });
    if (tier.bonusPoints > 0)
      expect(await points.balanceOf(BUYER)).toBe(tier.bonusPoints);
    expect(google.acknowledged).toEqual(['sub-tier']);
    // The same order again changes nothing.
    await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.tier,
        purchaseToken: 'sub-tier',
      })
      .expect(201);
    expect(
      (
        await prisma.makerTier.findUniqueOrThrow({
          where: { wawuUserId: BUYER },
        })
      ).activeUntil.toISOString(),
    ).toBe(view.grant.until);
  });

  // ------------------------------------------------------------------- passes

  it('a pass needs its room; refuses your own room, a room with no pass, and a removed member', async () => {
    sub('sub-pass', P.android.pass, 'GPA.p..0');
    const buy = (b: object) =>
      as(buyer).post('/store/purchases', {
        platform: 'android',
        productId: P.android.pass,
        purchaseToken: 'sub-pass',
        ...b,
      });
    let res = await buy({}).expect(400);
    expect(codeOf(res)).toBe('store_receipt_missing');
    res = await as(host)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.pass,
        purchaseToken: 'sub-pass',
        communityId: await room(HOST),
      })
      .expect(409);
    expect(codeOf(res)).toBe('store_pass_not_available');
    res = await buy({ communityId: await room(HOST, null) }).expect(409);
    expect(codeOf(res)).toBe('store_pass_not_available');
    const removedFrom = await room(HOST);
    await prisma.communityMembership.create({
      data: { userWawuId: BUYER, communityId: removedFrom, status: 'pending' },
    });
    res = await buy({ communityId: removedFrom }).expect(409);
    expect(codeOf(res)).toBe('store_pass_not_available');
    await buy({ communityId: randomUUID() }).expect(409);
    expect(
      await prisma.communityPass.count({ where: { userWawuId: BUYER } }),
    ).toBe(0);
  });

  it("a pass gives the chained period and membership through the pass grant code, and records the host's 85% of the net", async () => {
    const communityId = await room(HOST);
    sub('sub-pass2', P.android.pass, 'GPA.p2..0');
    const body = {
      platform: 'android',
      productId: P.android.pass,
      purchaseToken: 'sub-pass2',
      communityId,
    };
    const res = await as(buyer).post('/store/purchases', body).expect(201);
    const view = dataOf<{
      id: string;
      grant: { until: string; communityId: string };
    }>(res);
    const pass = await prisma.communityPass.findUniqueOrThrow({
      where: { walletPaymentId: `store:${view.id}` },
    });
    expect(pass).toMatchObject({ communityId, userWawuId: BUYER });
    expect(
      Math.round(
        (pass.endsAt.getTime() - pass.startsAt.getTime()) / 86_400_000,
      ),
    ).toBe(30);
    expect(pass.endsAt.toISOString()).toBe(view.grant.until);
    expect(
      await prisma.communityMembership.findUniqueOrThrow({
        where: { userWawuId_communityId: { userWawuId: BUYER, communityId } },
      }),
    ).toMatchObject({ status: 'joined' });
    // 15% of 200000 is the store's; the host's 85% of the 170000 left is 144500.
    expect(
      await prisma.storePurchase.findUniqueOrThrow({ where: { id: view.id } }),
    ).toMatchObject({
      referenceKobo: 200_000,
      netKobo: 170_000,
      creatorWawuUserId: HOST,
      creatorShareKobo: 144_500,
      communityId,
    });
    // The wallet's pass reads (GET /communities/:id/pass) go by the same rows: the access service sees it.
    const latest = await prisma.communityPass.aggregate({
      where: { communityId, userWawuId: BUYER },
      _max: { endsAt: true },
    });
    expect(latest._max.endsAt?.getTime()).toBeGreaterThan(Date.now());
    // The wallet's refund on host removal never reads a store pass: it is ended, nothing is paid back.
    await prisma.$transaction((tx) =>
      new CommunityPassRemoval(prisma)
        .decide(tx, { communityId, hostWawuId: HOST, userWawuId: BUYER })
        .then((id) => expect(id).toBeNull()),
    );
    expect(
      (
        await prisma.communityPass.findUniqueOrThrow({ where: { id: pass.id } })
      ).endsAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(
      await prisma.communityPassRefund.count({ where: { communityId } }),
    ).toBe(0);
  });

  // -------------------------------------------------------------- iOS

  it('an App Store transaction is read from Apple by id, never from the app', async () => {
    apple.transactions.set(
      '9001',
      verified({
        platform: 'ios',
        storeProductId: P.ios.points,
        storeTransactionId: '9001',
      }),
    );
    // the app names one product but the transaction is for another
    await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: P.ios.credits,
        transactionId: '9001',
      })
      .expect(422);
    await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: P.ios.points,
        transactionId: '9999',
      })
      .expect(422);
    apple.unreachable = true;
    expect(
      (
        await as(buyer)
          .post('/store/purchases', {
            platform: 'ios',
            productId: P.ios.points,
            transactionId: '9001',
          })
          .expect(503)
      ).body,
    ).toMatchObject({ reason: { code: 'store_unreachable' } });
    apple.unreachable = false;
    const ok = await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: P.ios.points,
        transactionId: '9001',
      })
      .expect(201);
    expect(dataOf(ok)).toMatchObject({
      platform: 'ios',
      status: 'granted',
      alreadyGranted: false,
    });
    expect(await points.balanceOf(BUYER)).toBe(
      countIn(plans.packs[0].points, 'NGN'),
    );
  });

  // ------------------------------------------------------------ notifications

  const push = (
    note: object,
    messageId = `m-${uid()}`,
    token = google.pushToken,
  ) =>
    http()
      .post(`${API}/webhooks/google-play`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        message: {
          data: Buffer.from(
            JSON.stringify({ packageName: 'africa.wawu.test', ...note }),
          ).toString('base64'),
          messageId,
        },
      });
  const outcomeOf = (res: request.Response) =>
    dataOf<{ outcome: string }>(res).outcome;
  const voided = (orderId: string, refundType = 1) => ({
    voidedPurchaseNotification: {
      orderId,
      purchaseToken: 'x',
      productType: 2,
      refundType,
    },
  });
  const subNote = (type: number, token: string, subscriptionId: string) => ({
    subscriptionNotification: {
      notificationType: type,
      purchaseToken: token,
      subscriptionId,
    },
  });

  it("a push needs Google's token and a Pub/Sub body; a message seen twice is acted on once", async () => {
    await http().post(`${API}/webhooks/google-play`).send({}).expect(401);
    await push({}, 'm1', 'wrong').expect(401);
    await http()
      .post(`${API}/webhooks/google-play`)
      .set('Authorization', `Bearer ${google.pushToken}`)
      .send({ nope: 1 })
      .expect(400);
    const orderId = packTokens('tok-dup');
    await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.points,
        purchaseToken: 'tok-dup',
      })
      .expect(201);
    expect(outcomeOf(await push(voided(orderId), 'same-id').expect(200))).toBe(
      'taken_back',
    );
    expect(outcomeOf(await push(voided(orderId), 'same-id').expect(200))).toBe(
      'duplicate',
    );
    expect(
      outcomeOf(
        await push({ testNotification: { version: '1.0' } }).expect(200),
      ),
    ).toBe('ignored');
    expect(
      outcomeOf(
        await push(
          { packageName: 'other', ...voided(orderId) },
          'm-other',
        ).expect(200),
      ),
    ).toBe('ignored');
    expect(outcomeOf(await push(voided('GPA.never-seen')).expect(200))).toBe(
      'unknown',
    );
  });

  it('a refund takes back the unspent points and not the spent ones, once, even with the store switched off', async () => {
    const orderId = packTokens('tok-refund');
    const bought = dataOf<{ id: string }>(
      await as(buyer)
        .post('/store/purchases', {
          platform: 'android',
          productId: P.android.points,
          purchaseToken: 'tok-refund',
        })
        .expect(201),
    );
    const total = countIn(plans.packs[0].points, 'NGN');
    const spent = Math.min(10, total);
    const hold = await points.hold({
      wawuUserId: BUYER,
      purpose: 'ai_job',
      reference: `iap-${uid()}`,
      points: spent,
    });
    await points.commit({ holdId: hold.holdId });
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: false })
      .expect(200);
    expect(outcomeOf(await push(voided(orderId)).expect(200))).toBe(
      'taken_back',
    );
    expect(outcomeOf(await push(voided(orderId)).expect(200))).toBe(
      'duplicate',
    );
    const row = await prisma.storePurchase.findUniqueOrThrow({
      where: { id: bought.id },
    });
    expect(row).toMatchObject({
      status: 'refunded',
      endReason: 'voided_by_store',
    });
    expect(row.takenBack).toEqual({
      points: total - spent,
      grantedPoints: total,
    });
    expect(await points.balanceOf(BUYER)).toBe(0);
    // A chargeback (not a full refund) is a revocation.
    const orderB = packTokens('tok-charge');
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: true })
      .expect(200);
    const b = dataOf<{ id: string }>(
      await as(buyer)
        .post('/store/purchases', {
          platform: 'android',
          productId: P.android.points,
          purchaseToken: 'tok-charge',
        })
        .expect(201),
    );
    await push(voided(orderB, 2)).expect(200);
    expect(
      (await prisma.storePurchase.findUniqueOrThrow({ where: { id: b.id } }))
        .status,
    ).toBe('revoked');
  });

  it('a refunded credits pack takes the credits left, not the ones spent', async () => {
    google.oneTime.set(
      'tok-crr',
      verified({
        platform: 'android',
        storeProductId: P.android.credits,
        storeTransactionId: 'GPA.crr',
      }),
    );
    const bought = dataOf<{ id: string }>(
      await as(buyer)
        .post('/store/purchases', {
          platform: 'android',
          productId: P.android.credits,
          purchaseToken: 'tok-crr',
        })
        .expect(201),
    );
    // 20 credits are spent in a room (the lot and the balance both go down).
    await prisma.creditLot.updateMany({
      where: { creditPurchase: { storePurchaseId: bought.id } },
      data: { creditsRemaining: 100 },
    });
    await prisma.creditsState.update({
      where: { userWawuId: BUYER },
      data: { creditBalance: 100 },
    });
    expect(outcomeOf(await push(voided('GPA.crr')).expect(200))).toBe(
      'taken_back',
    );
    expect(
      (
        await prisma.creditsState.findUniqueOrThrow({
          where: { userWawuId: BUYER },
        })
      ).creditBalance,
    ).toBe(0);
    expect(
      (
        await prisma.storePurchase.findUniqueOrThrow({
          where: { id: bought.id },
        })
      ).takenBack,
    ).toEqual({ credits: 100, grantedCredits: 120 });
    expect(
      await prisma.creditLot.findFirstOrThrow({
        where: { creditPurchase: { storePurchaseId: bought.id } },
      }),
    ).toMatchObject({ creditsRemaining: 0 });
  });

  it('a renewal extends the tier by another period, once per order; a revocation takes the period and its bonus back; a lapse ends the standing', async () => {
    const tier = plans.tiers[0];
    sub('sub-life', P.android.tier, 'GPA.life..0');
    const first = dataOf<{ id: string; grant: { until: string } }>(
      await as(buyer)
        .post('/store/purchases', {
          platform: 'android',
          productId: P.android.tier,
          purchaseToken: 'sub-life',
        })
        .expect(201),
    );
    // Google renews: the subscription now has a newer order.
    sub('sub-life', P.android.tier, 'GPA.life..1');
    expect(
      outcomeOf(await push(subNote(2, 'sub-life', P.android.tier)).expect(200)),
    ).toBe('granted');
    expect(
      outcomeOf(await push(subNote(2, 'sub-life', P.android.tier)).expect(200)),
    ).toBe('duplicate');
    const held = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: BUYER },
    });
    expect(
      held.activeUntil.getTime() - new Date(first.grant.until).getTime(),
    ).toBe(tier.days * 86_400_000);
    expect(
      await prisma.storePurchase.count({
        where: { subscriptionKey: 'sub-life' },
      }),
    ).toBe(2);
    // The store revokes the latest period.
    expect(
      outcomeOf(
        await push(subNote(12, 'sub-life', P.android.tier)).expect(200),
      ),
    ).toBe('taken_back');
    const after = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: BUYER },
    });
    expect(after.activeUntil.toISOString()).toBe(first.grant.until);
    const revoked = await prisma.storePurchase.findFirstOrThrow({
      where: { storeTransactionId: 'GPA.life..1' },
    });
    expect(revoked).toMatchObject({
      status: 'revoked',
      endReason: 'revoked_by_store',
    });
    // The tier purchase record stays (it is the record of a payment), and so does the bonus lot's end.
    expect(
      await prisma.makerPurchase.findUniqueOrThrow({
        where: { paymentRef: `store:${revoked.id}` },
      }),
    ).toMatchObject({ method: 'store', status: 'paid' });
    // The subscription expires: nothing more is coming; what was granted runs to its own end.
    expect(
      outcomeOf(
        await push(subNote(13, 'sub-life', P.android.tier)).expect(200),
      ),
    ).toBe('lapsed');
    expect(
      await prisma.storePurchase.count({
        where: { subscriptionKey: 'sub-life', endReason: 'lapsed' },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.storePurchase.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).status,
    ).toBe('granted');
    // A notice for a subscription the Hub has not seen is answered, not acted on.
    expect(
      outcomeOf(
        await push(subNote(2, 'sub-unseen', P.android.tier)).expect(200),
      ),
    ).toBe('unknown');
    // A cancel (auto-renew switched off) changes nothing.
    expect(
      outcomeOf(await push(subNote(3, 'sub-life', P.android.tier)).expect(200)),
    ).toBe('ignored');
  });

  it('a revoked pass ends its period now', async () => {
    const communityId = await room(HOST);
    sub('sub-pass3', P.android.pass, 'GPA.p3..0');
    const bought = dataOf<{ id: string }>(
      await as(buyer)
        .post('/store/purchases', {
          platform: 'android',
          productId: P.android.pass,
          purchaseToken: 'sub-pass3',
          communityId,
        })
        .expect(201),
    );
    // A renewal reaches the same room (the room comes from the first purchase).
    sub('sub-pass3', P.android.pass, 'GPA.p3..1');
    expect(
      outcomeOf(
        await push(subNote(2, 'sub-pass3', P.android.pass)).expect(200),
      ),
    ).toBe('granted');
    expect(
      await prisma.communityPass.count({
        where: { communityId, userWawuId: BUYER },
      }),
    ).toBe(2);
    expect(outcomeOf(await push(voided('GPA.p3..1')).expect(200))).toBe(
      'taken_back',
    );
    const second = await prisma.storePurchase.findFirstOrThrow({
      where: { storeTransactionId: 'GPA.p3..1' },
    });
    const row = await prisma.communityPass.findUniqueOrThrow({
      where: { walletPaymentId: `store:${second.id}` },
    });
    expect(row.endsAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.endsAt.getTime()).toBeGreaterThan(row.startsAt.getTime());
    expect(
      (
        await prisma.communityPass.findUniqueOrThrow({
          where: { walletPaymentId: `store:${bought.id}` },
        })
      ).endsAt.getTime(),
    ).toBeGreaterThan(Date.now());
  });

  it('a store that cannot be reached to check a notice is a 503 so it is sent again, and nothing is recorded as seen', async () => {
    sub('sub-503', P.android.tier, 'GPA.503..0');
    await as(buyer)
      .post('/store/purchases', {
        platform: 'android',
        productId: P.android.tier,
        purchaseToken: 'sub-503',
      })
      .expect(201);
    google.unreachable = true;
    const res = await push(
      subNote(2, 'sub-503', P.android.tier),
      'm-503',
    ).expect(503);
    expect(codeOf(res)).toBe('store_unreachable');
    expect(
      await prisma.storeNotification.count({ where: { externalId: 'm-503' } }),
    ).toBe(0);
  });

  // -------------------------------------------------------------- App Store

  const note = (
    id: string,
    type: string,
    t: ReturnType<typeof verified> | null,
    subtype: string | null = null,
  ) => {
    apple.notifications.set(`signed-${id}`, {
      notificationId: id,
      type,
      subtype,
      environment: 'production',
      transaction: t,
    });
    return http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: `signed-${id}` });
  };

  it("Apple's notices: a renewal grants, a refund takes back, an expiry lapses; one that does not verify is refused", async () => {
    const iosSub = (order: string) =>
      verified({
        platform: 'ios',
        storeProductId: P.ios.tier,
        storeTransactionId: order,
        subscriptionKey: 'orig-1',
        expiresAt: inDays(30),
      });
    apple.transactions.set('1001', iosSub('1001'));
    await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: P.ios.tier,
        transactionId: '1001',
      })
      .expect(201);
    expect(
      outcomeOf(await note('n1', 'DID_RENEW', iosSub('1002')).expect(200)),
    ).toBe('granted');
    expect(
      outcomeOf(await note('n1', 'DID_RENEW', iosSub('1002')).expect(200)),
    ).toBe('duplicate');
    expect(
      outcomeOf(await note('n1b', 'DID_RENEW', iosSub('1002')).expect(200)),
    ).toBe('duplicate');
    expect(
      await prisma.storePurchase.count({
        where: { subscriptionKey: 'orig-1' },
      }),
    ).toBe(2);
    expect(
      outcomeOf(await note('n2', 'REFUND', iosSub('1002')).expect(200)),
    ).toBe('taken_back');
    expect(
      (
        await prisma.storePurchase.findFirstOrThrow({
          where: { storeTransactionId: '1002' },
        })
      ).status,
    ).toBe('refunded');
    expect(
      outcomeOf(
        await note('n3', 'EXPIRED', iosSub('1001'), 'VOLUNTARY').expect(200),
      ),
    ).toBe('lapsed');
    expect(
      outcomeOf(await note('n4', 'REVOKE', iosSub('1001')).expect(200)),
    ).toBe('taken_back');
    expect(
      (
        await prisma.storePurchase.findFirstOrThrow({
          where: { storeTransactionId: '1001' },
        })
      ).status,
    ).toBe('revoked');
    expect(outcomeOf(await note('n5', 'TEST', null).expect(200))).toBe(
      'ignored',
    );
    expect(
      outcomeOf(
        await note('n6', 'DID_RENEW', {
          ...iosSub('1009'),
          subscriptionKey: 'orig-unseen',
        }).expect(200),
      ),
    ).toBe('unknown');
    await http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: 'forged' })
      .expect(401);
    await http().post(`${API}/webhooks/app-store`).send({}).expect(400);
    apple.unreachable = true;
    expect(
      codeOf(await note('n7', 'DID_RENEW', iosSub('1003')).expect(503)),
    ).toBe('store_unreachable');
  });

  // ------------------------------------------------------------------- admin

  it('the admin routes are for superadmin and finance only', async () => {
    for (const role of [AdminRole.support, AdminRole.reviewer]) {
      await admin(role).get('/admin/store/products').expect(403);
      await admin(role).get('/admin/store/platforms').expect(403);
      await admin(role).get('/admin/store/purchases').expect(403);
      await admin(role).get('/admin/store/refunds').expect(403);
      await admin(role)
        .patch('/admin/store/platforms/ios', { enabled: false })
        .expect(403);
    }
    await admin(AdminRole.superadmin).get('/admin/store/products').expect(200);
  });

  it('an admin edits the product map; a grant that does not fit its kind or the plan is refused with a plain sentence', async () => {
    const create = (b: object) =>
      admin(AdminRole.finance).post('/admin/store/products', b);
    const created = await create({
      platform: 'ios',
      storeProductId: 'wawu.credits.pro',
      kind: 'credits',
      title: 'Credits pro',
      grants: { pack: 'pro' },
    }).expect(201);
    const row = dataOf<{
      id: string;
      referenceKobo: number;
      resolved: { credits: number };
      updatedBy: string;
    }>(created);
    // The reference defaults to the pack's wallet price (Default (lead), owner may override).
    expect(row).toMatchObject({
      referenceKobo: 200_000,
      resolved: { credits: 300 },
    });
    expect(row.updatedBy).toBe(adminIds[1]);
    let res = await create({
      platform: 'ios',
      storeProductId: 'wawu.credits.pro',
      kind: 'credits',
      title: 'x',
      grants: { pack: 'pro' },
    }).expect(400);
    expect(codeOf(res)).toBe('store_product_invalid');
    res = await create({
      platform: 'ios',
      storeProductId: 'a1',
      kind: 'points',
      title: 'x',
      grants: { packId: 'no_such_pack' },
    }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'That points pack is not in the plan.',
    );
    await create({
      platform: 'ios',
      storeProductId: 'a2',
      kind: 'tier',
      title: 'x',
      grants: { tierId: 'no_such_tier' },
    }).expect(400);
    await create({
      platform: 'ios',
      storeProductId: 'a3',
      kind: 'pass',
      title: 'x',
      grants: { days: 30 },
    }).expect(400);
    await create({
      platform: 'ios',
      storeProductId: 'a4',
      kind: 'points',
      title: 'x',
      grants: { packId, days: 3 },
    }).expect(400);
    await create({
      platform: 'ios',
      storeProductId: 'a5',
      kind: 'pass',
      title: 'x',
      grants: { days: 30 },
      referenceKobo: 5000,
      bogus: true,
    }).expect(400);
    const patched = await admin(AdminRole.finance)
      .patch(`/admin/store/products/${row.id}`, {
        title: 'Credits (large)',
        active: false,
        referenceKobo: 190_000,
      })
      .expect(200);
    expect(dataOf(patched)).toMatchObject({
      title: 'Credits (large)',
      active: false,
      referenceKobo: 190_000,
    });
    const ios = dataOf<{ products: Array<{ storeProductId: string }> }>(
      await as(buyer).get('/store/products?platform=ios'),
    );
    expect(ios.products.map((p) => p.storeProductId)).not.toContain(
      'wawu.credits.pro',
    );
    await admin(AdminRole.finance)
      .patch(`/admin/store/products/${randomUUID()}`, { title: 'x' })
      .expect(404);
    await prisma.storeProduct.delete({ where: { id: row.id } });
  });

  it('the dashboard lists purchases newest first, filtered and paged, and the refunds on their own', async () => {
    for (let i = 0; i < 3; i += 1) {
      const orderId = packTokens(`tok-list-${i}`, `GPA.list${i}`);
      void orderId;
      await as(buyer)
        .post('/store/purchases', {
          platform: 'android',
          productId: P.android.points,
          purchaseToken: `tok-list-${i}`,
        })
        .expect(201);
    }
    await push(voided('GPA.list1')).expect(200);
    const page1 = dataOf<{
      items: Array<{ storeTransactionId: string; status: string }>;
      nextCursor: string | null;
    }>(
      await admin(AdminRole.finance)
        .get('/admin/store/purchases?limit=2')
        .expect(200),
    );
    expect(page1.items.map((i) => i.storeTransactionId)).toEqual([
      'GPA.list2',
      'GPA.list1',
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = dataOf<{
      items: Array<{ storeTransactionId: string }>;
      nextCursor: string | null;
    }>(
      await admin(AdminRole.finance)
        .get(`/admin/store/purchases?limit=2&cursor=${page1.nextCursor}`)
        .expect(200),
    );
    expect(page2.items.map((i) => i.storeTransactionId)).toEqual(['GPA.list0']);
    expect(page2.nextCursor).toBeNull();
    const refunds = dataOf<{
      items: Array<{
        storeTransactionId: string;
        takenBack: { points: number };
      }>;
    }>(await admin(AdminRole.finance).get('/admin/store/refunds').expect(200));
    expect(refunds.items).toHaveLength(1);
    expect(refunds.items[0]).toMatchObject({ storeTransactionId: 'GPA.list1' });
    expect(refunds.items[0].takenBack.points).toBeGreaterThan(0);
    expect(
      dataOf<{ items: unknown[] }>(
        await admin(AdminRole.finance)
          .get('/admin/store/purchases?platform=ios')
          .expect(200),
      ).items,
    ).toHaveLength(0);
    expect(
      dataOf<{ items: unknown[] }>(
        await admin(AdminRole.finance)
          .get(
            `/admin/store/purchases?wawuUserId=${BUYER}&kind=points&status=granted`,
          )
          .expect(200),
      ).items,
    ).toHaveLength(2);
    await admin(AdminRole.finance)
      .get('/admin/store/purchases?cursor=garbage')
      .expect(400);
    await admin(AdminRole.finance)
      .get('/admin/store/purchases?limit=500')
      .expect(400);
  });

  it("GET /admin/store/platforms says whether the Hub holds each store's credentials and which cut applies", async () => {
    const res = await admin(AdminRole.finance)
      .get('/admin/store/platforms')
      .expect(200);
    expect(dataOf<{ items: unknown[] }>(res).items).toEqual([
      expect.objectContaining({
        platform: 'android',
        enabled: true,
        configured: true,
        storeFeeBps: 1500,
        storeFeeOverridden: false,
      }),
      expect.objectContaining({
        platform: 'ios',
        enabled: true,
        configured: true,
        storeFeeBps: 3000,
        storeFeeOverridden: false,
      }),
    ]);
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/windows', { enabled: false })
      .expect(400);
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/ios', { storeFeeBps: 10_001 })
      .expect(400);
  });
});
