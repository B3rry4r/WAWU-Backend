// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief) — same convention as every other Phase 5 contract spec (see
// src/course-enrollment/tests/course-enrollment.contract.spec.ts).
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreatorEarningsModule } from '../creator-earnings.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see src/course-enrollment/tests/course-enrollment.contract.spec.ts's own
// precedent comment).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user, not a creator
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic tier -> 0.15 commission
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro tier, subscriptionPaid -> 0.10 commission

// Seeded Community (prisma/seed.ts COMMUNITY_FOUNDERS) — reused only as a
// valid FK target for test CreditSpend rows, never mutated itself.
const COMMUNITY_FOUNDERS = '20000000-0000-4000-8000-000000000001';

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

/**
 * These specs never assert an ABSOLUTE payable/held/total against the
 * shared wawu_hub_test DB — prior waves' contract specs (e.g.
 * src/purchase/tests/purchase.contract.spec.ts) create Purchase rows
 * against these same seeded creators WITHOUT afterAll cleanup, so the
 * "baseline" earnings figure for USER_CREATOR_BASIC / USER_CREATOR_PRO is
 * not reliably zero or stable across test runs. Instead: read the current
 * figure, create a small set of exactly-tracked rows, read again, and
 * assert the DELTA — robust to whatever pre-existing pollution is already
 * in the DB. Every row this suite creates is deleted by its own captured
 * id in afterAll (never a broad deleteMany-by-creator, which could delete
 * another concurrently-running suite's rows too).
 */
describe('CreatorEarnings (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainUserToken: string;
  let basicCreatorToken: string;
  let proCreatorToken: string;

  const createdPurchaseIds: string[] = [];
  const createdDmIds: string[] = [];
  const createdCreditSpendIds: string[] = [];

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

    plainUserToken = await login('user@test.wawu.dev');
    basicCreatorToken = await login('creator-basic@test.wawu.dev');
    proCreatorToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CreatorEarningsModule,
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
  }, 30000);

  afterAll(async () => {
    // Precise, id-scoped cleanup only — never a broad deleteMany-by-creator
    // (task brief § test hygiene: don't clobber another suite's rows in
    // the shared DB).
    if (createdPurchaseIds.length) {
      await prisma.purchase.deleteMany({
        where: { id: { in: createdPurchaseIds } },
      });
    }
    if (createdDmIds.length) {
      await prisma.directMessage.deleteMany({
        where: { id: { in: createdDmIds } },
      });
    }
    if (createdCreditSpendIds.length) {
      await prisma.creditSpend.deleteMany({
        where: { id: { in: createdCreditSpendIds } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /content/mine/earnings', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .expect(401);
    });

    it('403s a plain (non-creator) user', async () => {
      await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(403);
    });

    it('returns the frozen envelope shape for a creator (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      const data = res.body.data;
      expect(typeof data.total).toBe('number');
      expect(typeof data.payable).toBe('number');
      expect(typeof data.held).toBe('number');
      expect(Array.isArray(data.recentSales)).toBe(true);
      expect(Array.isArray(data.streamBreakdown)).toBe(true);
      const streams = data.streamBreakdown
        .map((e: { stream: string }) => e.stream)
        .sort();
      expect(streams).toEqual(['community_credits', 'content', 'dm', 'tips']);
      // No subscription entry anywhere — a creator's own CreatorSubscription
      // payment is money THEY pay WAWU, never their own earning.
      expect(
        data.recentSales.every(
          (s: { source: string }) => s.source !== 'subscription',
        ),
      ).toBe(true);
    });

    it('aggregates Purchase (content+tip) at 0.15 for a Basic creator, DM held vs payable, and never converts credits to naira', async () => {
      const before = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      const contentPurchase = await prisma.purchase.create({
        data: {
          contentId: null,
          type: 'content',
          buyerWawuId: USER_PLAIN,
          creatorWawuId: USER_CREATOR_BASIC,
          amount: 1000,
          commissionRate: 0.15,
          flutterwaveTxRef: `test-earnings-${randomUUID()}`,
          flutterwaveTxId: 'flw-tx-earnings-1',
          status: 'completed',
          note: null,
        },
      });
      createdPurchaseIds.push(contentPurchase.id);

      const tipPurchase = await prisma.purchase.create({
        data: {
          contentId: null,
          type: 'tip',
          buyerWawuId: USER_PLAIN,
          creatorWawuId: USER_CREATOR_BASIC,
          amount: 500,
          commissionRate: 0.15,
          flutterwaveTxRef: `test-earnings-${randomUUID()}`,
          flutterwaveTxId: 'flw-tx-earnings-2',
          status: 'completed',
          note: null,
        },
      });
      createdPurchaseIds.push(tipPurchase.id);

      // A pending Purchase must NOT be counted anywhere (not payable, not held).
      const pendingPurchase = await prisma.purchase.create({
        data: {
          contentId: null,
          type: 'tip',
          buyerWawuId: USER_PLAIN,
          creatorWawuId: USER_CREATOR_BASIC,
          amount: 9999,
          commissionRate: 0.15,
          flutterwaveTxRef: `test-earnings-${randomUUID()}`,
          flutterwaveTxId: null,
          status: 'pending',
          note: null,
        },
      });
      createdPurchaseIds.push(pendingPurchase.id);

      const respondedDm = await prisma.directMessage.create({
        data: {
          creatorWawuId: USER_CREATOR_BASIC,
          senderWawuId: USER_PLAIN,
          text: 'test dm responded',
          amount: 200,
          status: 'responded',
          deadlineAt: new Date(Date.now() + 86_400_000),
          respondedAt: new Date(),
          responseText: 'ok',
          flutterwaveTxRef: `test-earnings-dm-${randomUUID()}`,
        },
      });
      createdDmIds.push(respondedDm.id);

      const awaitingDm = await prisma.directMessage.create({
        data: {
          creatorWawuId: USER_CREATOR_BASIC,
          senderWawuId: USER_PLAIN,
          text: 'test dm awaiting',
          amount: 100,
          status: 'awaiting_response',
          deadlineAt: new Date(Date.now() + 86_400_000),
          flutterwaveTxRef: `test-earnings-dm-${randomUUID()}`,
        },
      });
      createdDmIds.push(awaitingDm.id);

      // A refunded DM must NOT be counted anywhere — the money went back to the sender.
      const refundedDm = await prisma.directMessage.create({
        data: {
          creatorWawuId: USER_CREATOR_BASIC,
          senderWawuId: USER_PLAIN,
          text: 'test dm refunded',
          amount: 777,
          status: 'refunded',
          deadlineAt: new Date(Date.now() - 1000),
          flutterwaveTxRef: `test-earnings-dm-${randomUUID()}`,
        },
      });
      createdDmIds.push(refundedDm.id);

      const creditSpend1 = await prisma.creditSpend.create({
        data: {
          userWawuId: USER_PLAIN,
          communityId: COMMUNITY_FOUNDERS,
          creatorWawuId: USER_CREATOR_BASIC,
          creditsSpent: 1,
        },
      });
      createdCreditSpendIds.push(creditSpend1.id);
      const creditSpend2 = await prisma.creditSpend.create({
        data: {
          userWawuId: USER_PLAIN,
          communityId: COMMUNITY_FOUNDERS,
          creatorWawuId: USER_CREATOR_BASIC,
          creditsSpent: 1,
        },
      });
      createdCreditSpendIds.push(creditSpend2.id);

      const after = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      const b = before.body.data;
      const a = after.body.data;

      // 1000 * 0.85 = 850 (content), 500 * 0.85 = 425 (tip), 200 * 0.85 = 170 (dm responded)
      expect(a.payable - b.payable).toBeCloseTo(850 + 425 + 170, 5);
      // 100 * 0.85 = 85 (dm awaiting)
      expect(a.held - b.held).toBeCloseTo(85, 5);
      expect(a.total - b.total).toBeCloseTo(850 + 425 + 170 + 85, 5);

      const streamDelta = (stream: string) => {
        const av =
          a.streamBreakdown.find((e: { stream: string }) => e.stream === stream)
            ?.amount ?? 0;
        const bv =
          b.streamBreakdown.find((e: { stream: string }) => e.stream === stream)
            ?.amount ?? 0;
        return av - bv;
      };
      expect(streamDelta('content')).toBeCloseTo(850, 5);
      expect(streamDelta('tips')).toBeCloseTo(425, 5);
      expect(streamDelta('dm')).toBeCloseTo(170 + 85, 5);
      // Credits stream is a raw COUNT (2 credits spent), never a naira figure.
      expect(streamDelta('community_credits')).toBeCloseTo(2, 5);

      // recentSales: the 4 sale-generating rows must appear; the refunded
      // DM and the still-pending Purchase must NOT.
      const ids = a.recentSales.map((s: { id: string }) => s.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          contentPurchase.id,
          tipPurchase.id,
          respondedDm.id,
          awaitingDm.id,
        ]),
      );
      expect(ids).not.toContain(refundedDm.id);
      expect(ids).not.toContain(pendingPurchase.id);

      const creditSale = a.recentSales.find(
        (s: { id: string }) => s.id === creditSpend1.id,
      );
      if (creditSale) {
        // If present in the top-N window, its amount is a credit count (1), never naira.
        expect(creditSale.amount).toBe(1);
        expect(creditSale.source).toBe('community_credits');
      }
    });

    it('applies the 0.10 Pro-tier commission live to a DM for a Pro creator (not the 0.15 standard rate)', async () => {
      const before = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(200);

      const proDm = await prisma.directMessage.create({
        data: {
          creatorWawuId: USER_CREATOR_PRO,
          senderWawuId: USER_PLAIN,
          text: 'test pro dm responded',
          amount: 1000,
          status: 'responded',
          deadlineAt: new Date(Date.now() + 86_400_000),
          respondedAt: new Date(),
          responseText: 'ok',
          flutterwaveTxRef: `test-earnings-pro-dm-${randomUUID()}`,
        },
      });
      createdDmIds.push(proDm.id);

      const after = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(200);

      // 1000 * (1 - 0.10) = 900, NOT 1000 * (1 - 0.15) = 850.
      expect(after.body.data.payable - before.body.data.payable).toBeCloseTo(
        900,
        5,
      );
    });
  });
});
