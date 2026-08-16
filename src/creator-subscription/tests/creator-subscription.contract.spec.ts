// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// task brief), mirroring src/notification/tests/notification.contract.spec.ts
// and src/blocked-account/tests/blocked-account.contract.spec.ts's own
// precedent — PrismaService reads process.env.DATABASE_URL directly (not
// via ConfigService), so this must be set before PrismaModule/PrismaService
// is ever instantiated below.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreatorSubscriptionModule } from '../creator-subscription.module';
import {
  MOCK_FAILURE_TRANSACTION_ID,
  MOCK_RETRY_FAILURE_CUSTOMER_REF,
} from '../mock-flutterwave.adapter';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

const BASIC_ANNUAL_PRICE = 5999;
const PRO_ANNUAL_PRICE = 18999;

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('CreatorSubscription (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorBasicToken: string;
  let creatorProToken: string;

  // Snapshots of the seeded rows this suite mutates — restored in afterAll
  // so reruns of this suite, and any other resource's suite that happens to
  // run against the same wawu_hub_test database, see stable seeded state
  // (mirrors src/verification-submission/tests's own documented precedent).
  let originalBasicSub: Awaited<
    ReturnType<PrismaService['creatorSubscription']['findUniqueOrThrow']>
  >;
  let originalProSub: Awaited<
    ReturnType<PrismaService['creatorSubscription']['findUniqueOrThrow']>
  >;
  let originalBasicState: Awaited<
    ReturnType<PrismaService['creatorState']['findUniqueOrThrow']>
  >;
  let originalProState: Awaited<
    ReturnType<PrismaService['creatorState']['findUniqueOrThrow']>
  >;

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    userToken = await login('user@test.wawu.dev');
    creatorBasicToken = await login('creator-basic@test.wawu.dev');
    creatorProToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CreatorSubscriptionModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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

    prisma = moduleRef.get(PrismaService);

    originalBasicSub = await prisma.creatorSubscription.findUniqueOrThrow({
      where: { creatorWawuId: USER_CREATOR_BASIC },
    });
    originalProSub = await prisma.creatorSubscription.findUniqueOrThrow({
      where: { creatorWawuId: USER_CREATOR_PRO },
    });
    originalBasicState = await prisma.creatorState.findUniqueOrThrow({
      where: { wawuUserId: USER_CREATOR_BASIC },
    });
    originalProState = await prisma.creatorState.findUniqueOrThrow({
      where: { wawuUserId: USER_CREATOR_PRO },
    });

    // Clean slate for USER_PLAIN's own subscribe-from-scratch flow, in case
    // a previous failed run left rows behind.
    await prisma.creatorSubscription.deleteMany({
      where: { creatorWawuId: USER_PLAIN },
    });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: USER_PLAIN } });
  }, 30000);

  afterAll(async () => {
    if (prisma) {
      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_BASIC },
        data: {
          tier: originalBasicSub.tier,
          status: originalBasicSub.status,
          commissionRateOverride: originalBasicSub.commissionRateOverride,
          flutterwaveCustomerRef: originalBasicSub.flutterwaveCustomerRef,
          flutterwavePlanId: originalBasicSub.flutterwavePlanId,
          currentPeriodEnd: originalBasicSub.currentPeriodEnd,
          renewalAttempts: originalBasicSub.renewalAttempts,
          cancelsAt: originalBasicSub.cancelsAt,
          cardLast4: originalBasicSub.cardLast4,
        },
      });
      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_PRO },
        data: {
          tier: originalProSub.tier,
          status: originalProSub.status,
          commissionRateOverride: originalProSub.commissionRateOverride,
          flutterwaveCustomerRef: originalProSub.flutterwaveCustomerRef,
          flutterwavePlanId: originalProSub.flutterwavePlanId,
          currentPeriodEnd: originalProSub.currentPeriodEnd,
          renewalAttempts: originalProSub.renewalAttempts,
          cancelsAt: originalProSub.cancelsAt,
          cardLast4: originalProSub.cardLast4,
        },
      });
      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: {
          tier: originalBasicState.tier,
          subscriptionPaid: originalBasicState.subscriptionPaid,
        },
      });
      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_PRO },
        data: {
          tier: originalProState.tier,
          subscriptionPaid: originalProState.subscriptionPaid,
        },
      });
      await prisma.creatorSubscription.deleteMany({
        where: { creatorWawuId: USER_PLAIN },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: USER_PLAIN },
      });
    }

    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /creator-subscription', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/creator-subscription')
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator-subscription')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it('404s for a creator account that has never subscribed', async () => {
      await prisma.creatorSubscription.deleteMany({
        where: { creatorWawuId: USER_CREATOR_BASIC },
      });

      const res = await request(app.getHttpServer())
        .get('/creator-subscription')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(404);
      expect(res.body.data).toBeNull();

      // Restore immediately — later tests in this file expect the seeded
      // row to exist.
      await prisma.creatorSubscription.create({ data: originalBasicSub });
    });

    it('returns the current row for the Basic creator (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator-subscription')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(200);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          creatorWawuId: USER_CREATOR_BASIC,
          tier: 'basic',
          status: 'active',
          commissionRateOverride: null,
        }),
      );
    });

    it('returns the current row for the Pro creator with a numeric commissionRateOverride (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator-subscription')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          creatorWawuId: USER_CREATOR_PRO,
          tier: 'pro',
          status: 'active',
          commissionRateOverride: 0.1,
        }),
      );
    });
  });

  describe('POST /creator-subscription (roles: any) + POST /creator-subscription/verify', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription')
        .send({ tier: 'basic' })
        .expect(401);
    });

    it('400s on an invalid tier', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'ultra' })
        .expect(400);
    });

    it('rejects an already-active Basic subscriber re-subscribing (400)', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ tier: 'basic' })
        .expect(400);
    });

    it('rejects an already-active Pro subscriber re-subscribing (400)', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ tier: 'pro' })
        .expect(400);
    });

    it('404s verify for a tx_ref that was never initialized', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'whatever', tx_ref: 'no-such-ref' })
        .expect(404);
    });

    it('400s verify on a failed Flutterwave transaction, then 404s a second verify against the same reference', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/creator-subscription')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'basic' });
      expect([200, 201]).toContain(initRes.status);
      const txRef = initRes.body.data.flutterwaveConfig.txRef;

      await request(app.getHttpServer())
        .post('/creator-subscription/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: MOCK_FAILURE_TRANSACTION_ID, tx_ref: txRef })
        .expect(400);

      // The pending attempt is consumed on resolution either way — a
      // second verify against the same tx_ref has nothing left to match.
      await request(app.getHttpServer())
        .post('/creator-subscription/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'irrelevant', tx_ref: txRef })
        .expect(404);
    });

    it('completes the full subscribe flow for a first-time (plain-account) subscriber (₦5,999 Basic)', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/creator-subscription')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'basic' });
      expect([200, 201]).toContain(initRes.status);
      expect(initRes.body.data.flutterwaveConfig).toEqual(
        expect.objectContaining({
          amount: BASIC_ANNUAL_PRICE,
          currency: 'NGN',
          txRef: expect.any(String),
        }),
      );
      const txRef = initRes.body.data.flutterwaveConfig.txRef;

      const verifyRes = await request(app.getHttpServer())
        .post('/creator-subscription/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'real-looking-tx-id', tx_ref: txRef });
      expect([200, 201]).toContain(verifyRes.status);
      expect(verifyRes.body.data).toEqual(
        expect.objectContaining({
          creatorWawuId: USER_PLAIN,
          tier: 'basic',
          status: 'active',
          commissionRateOverride: null,
          cardLast4: '4242',
        }),
      );

      // This is the ONLY code path allowed to set CreatorState.subscriptionPaid
      // = true (task brief) — assert it actually happened.
      const state = await prisma.creatorState.findUnique({
        where: { wawuUserId: USER_PLAIN },
      });
      expect(state).toEqual(
        expect.objectContaining({ tier: 'basic', subscriptionPaid: true }),
      );

      // GET /creator-subscription is creator-role-gated on
      // UserProfile.accountType (CreatorAccountGuard) — this resource never
      // touches UserProfile (out of scope; accountType conversion is
      // UserProfile's own PATCH /users/me concern), so a plain account that
      // has just subscribed correctly still 403s here until they separately
      // complete creator-account onboarding. Assert the persisted row
      // directly instead.
      const stored = await prisma.creatorSubscription.findUnique({
        where: { creatorWawuId: USER_PLAIN },
      });
      expect(stored?.tier).toBe('basic');
      expect(stored?.status).toBe('active');
    });
  });

  describe('POST /creator-subscription/upgrade + verify (Basic -> Pro, prorated)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/upgrade')
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/upgrade')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('400s for an already-Pro subscriber', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/upgrade')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(400);
    });

    it('initializes a prorated charge for the Basic subscriber, between ₦1 and the full Pro price', async () => {
      const res = await request(app.getHttpServer())
        .post('/creator-subscription/upgrade')
        .set('Authorization', `Bearer ${creatorBasicToken}`);
      expect([200, 201]).toContain(res.status);
      const { amount, currency, txRef } = res.body.data.flutterwaveConfig;
      expect(currency).toBe('NGN');
      expect(typeof txRef).toBe('string');
      expect(amount).toBeGreaterThanOrEqual(1);
      expect(amount).toBeLessThanOrEqual(PRO_ANNUAL_PRICE);
    });

    it('400s verify on a failed Flutterwave transaction (tier stays Basic)', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/creator-subscription/upgrade')
        .set('Authorization', `Bearer ${creatorBasicToken}`);
      const txRef = initRes.body.data.flutterwaveConfig.txRef;

      await request(app.getHttpServer())
        .post('/creator-subscription/verify')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ transaction_id: MOCK_FAILURE_TRANSACTION_ID, tx_ref: txRef })
        .expect(400);

      const res = await request(app.getHttpServer())
        .get('/creator-subscription')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(200);
      expect(res.body.data.tier).toBe('basic');
    });

    it('completes the upgrade on a successful verify: tier -> pro, 90/10 override, currentPeriodEnd unchanged', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/creator-subscription/upgrade')
        .set('Authorization', `Bearer ${creatorBasicToken}`);
      const txRef = initRes.body.data.flutterwaveConfig.txRef;

      const verifyRes = await request(app.getHttpServer())
        .post('/creator-subscription/verify')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ transaction_id: 'real-looking-tx-id', tx_ref: txRef });
      expect([200, 201]).toContain(verifyRes.status);
      expect(verifyRes.body.data).toEqual(
        expect.objectContaining({
          creatorWawuId: USER_CREATOR_BASIC,
          tier: 'pro',
          status: 'active',
          commissionRateOverride: 0.1,
        }),
      );
      // The annual anniversary does not reset on an upgrade — only the
      // amount paid today (prorated) and the future renewal price change.
      expect(new Date(verifyRes.body.data.currentPeriodEnd).getTime()).toBe(
        originalBasicSub.currentPeriodEnd.getTime(),
      );

      const state = await prisma.creatorState.findUnique({
        where: { wawuUserId: USER_CREATOR_BASIC },
      });
      expect(state?.tier).toBe('pro');
    });
  });

  describe('POST /creator-subscription/downgrade (Pro -> Basic, effective at period end)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/downgrade')
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/downgrade')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('400s for a subscriber already on Basic', async () => {
      // Basic-tier fixture: seeded creator-pro's flutterwaveCustomerRef
      // stays pro throughout this describe block; use a fresh Basic check
      // against the not-yet-mutated seeded Basic row would require test
      // ordering guarantees, so this asserts against creator-pro's sibling
      // precondition instead — a tier==='pro' check rejecting a basic
      // subscriber is exercised directly below via the success case.
      // (creator-basic was upgraded to pro in the previous describe block,
      // so it is intentionally not used here.)
      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_PRO },
        data: { tier: 'basic' },
      });
      await request(app.getHttpServer())
        .post('/creator-subscription/downgrade')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(400);
      // restore
      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_PRO },
        data: { tier: 'pro' },
      });
    });

    it('returns the current (unchanged) row for an active Pro subscriber (200)', async () => {
      const res = await request(app.getHttpServer())
        .post('/creator-subscription/downgrade')
        .set('Authorization', `Bearer ${creatorProToken}`);
      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          creatorWawuId: USER_CREATOR_PRO,
          tier: 'pro',
        }),
      );
    });
  });

  describe('DELETE /creator-subscription (cancelPro)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .delete('/creator-subscription')
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .delete('/creator-subscription')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('sets cancelsAt = currentPeriodEnd and leaves status active (200)', async () => {
      const res = await request(app.getHttpServer())
        .delete('/creator-subscription')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      expect(res.body.data.status).toBe('active');
      expect(res.body.data.cancelsAt).not.toBeNull();
      expect(new Date(res.body.data.cancelsAt).getTime()).toBe(
        new Date(res.body.data.currentPeriodEnd).getTime(),
      );
    });

    it('is idempotent — calling again returns the same row without erroring (200)', async () => {
      const res = await request(app.getHttpServer())
        .delete('/creator-subscription')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);
      expect(res.body.data.cancelsAt).not.toBeNull();
    });
  });

  describe('PATCH /creator-subscription/card', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .patch('/creator-subscription/card')
        .send({ flutterwaveCardToken: 'tok_test_1234' })
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .patch('/creator-subscription/card')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ flutterwaveCardToken: 'tok_test_1234' })
        .expect(403);
    });

    it('400s on a too-short token', async () => {
      await request(app.getHttpServer())
        .patch('/creator-subscription/card')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ flutterwaveCardToken: 'abc' })
        .expect(400);
    });

    it('derives and stores last4 from the token (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator-subscription/card')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ flutterwaveCardToken: 'tok_test_visa_ending_9999' })
        .expect(200);
      expect(res.body.data).toEqual({ last4: '9999' });

      const row = await prisma.creatorSubscription.findUnique({
        where: { creatorWawuId: USER_CREATOR_PRO },
      });
      expect(row?.cardLast4).toBe('9999');
    });
  });

  describe('POST /creator-subscription/retry-payment', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/retry-payment')
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/retry-payment')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('400s when the subscription is not currently past_due', async () => {
      await request(app.getHttpServer())
        .post('/creator-subscription/retry-payment')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(400);
    });

    it('on a declining saved card: 400s, increments renewalAttempts, stays past_due', async () => {
      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_PRO },
        data: {
          status: 'past_due',
          renewalAttempts: 0,
          flutterwaveCustomerRef: MOCK_RETRY_FAILURE_CUSTOMER_REF,
        },
      });

      await request(app.getHttpServer())
        .post('/creator-subscription/retry-payment')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(400);

      const row = await prisma.creatorSubscription.findUnique({
        where: { creatorWawuId: USER_CREATOR_PRO },
      });
      expect(row?.status).toBe('past_due');
      expect(row?.renewalAttempts).toBe(1);
    });

    it('on a successful saved-card charge: 200s, status -> active, renewalAttempts reset, currentPeriodEnd extended', async () => {
      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_PRO },
        data: {
          status: 'past_due',
          flutterwaveCustomerRef: originalProSub.flutterwaveCustomerRef,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/creator-subscription/retry-payment')
        .set('Authorization', `Bearer ${creatorProToken}`);
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.flutterwaveConfig).toEqual(
        expect.objectContaining({ currency: 'NGN', amount: PRO_ANNUAL_PRICE }),
      );

      const row = await prisma.creatorSubscription.findUnique({
        where: { creatorWawuId: USER_CREATOR_PRO },
      });
      expect(row?.status).toBe('active');
      expect(row?.renewalAttempts).toBe(0);
      expect(row!.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('GET /creator-subscription/billing-history', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/creator-subscription/billing-history')
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .get('/creator-subscription/billing-history')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('returns an empty, correctly-shaped paginated response (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator-subscription/billing-history')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({
          currentPage: 1,
          perPage: 20,
          total: 0,
          nextPage: null,
        }),
      );
    });
  });
});
