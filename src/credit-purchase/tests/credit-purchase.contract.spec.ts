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
import { CreditPurchaseModule } from '../credit-purchase.module';
import { MOCK_FAILURE_TRANSACTION_ID } from '../mock-flutterwave.adapter';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic tier

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

describe('CreditPurchase (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorBasicToken: string;

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

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CreditPurchaseModule,
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
    // This suite's verify tests grant real credits onto the seeded users'
    // shared CreditsState rows (not throwaway rows) -- restore seed.ts's
    // default so other suites sharing wawu_hub_test see a stable balance.
    await prisma?.creditsState.updateMany({
      where: { userWawuId: { in: [USER_PLAIN, USER_CREATOR_BASIC] } },
      data: { creditBalance: 48 },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('POST /credits/purchase', () => {
    it('creates a pending CreditPurchase and returns flutterwaveConfig for the starter pack (200/201, ₦500/50 credits)', async () => {
      const res = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pack: 'starter' });

      expect([200, 201]).toContain(res.status);
      const config = res.body.data.flutterwaveConfig;
      expect(config).toEqual(
        expect.objectContaining({
          txRef: expect.any(String),
          amount: 500,
          currency: 'NGN',
          publicKey: expect.any(String),
        }),
      );

      const stored = await prisma.creditPurchase.findFirst({
        where: { flutterwaveTxRef: config.txRef },
      });
      expect(stored).not.toBeNull();
      expect(stored?.userWawuId).toBe(USER_PLAIN);
      expect(stored?.pack).toBe('starter');
      expect(stored?.creditsGranted).toBe(50);
      expect(stored?.amount).toBe(500);
      expect(stored?.status).toBe('pending');
    });

    it('looks up the popular pack (₦1000/120 credits) server-side', async () => {
      const res = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pack: 'popular' });

      expect([200, 201]).toContain(res.status);
      const config = res.body.data.flutterwaveConfig;
      expect(config.amount).toBe(1000);

      const stored = await prisma.creditPurchase.findFirst({
        where: { flutterwaveTxRef: config.txRef },
      });
      expect(stored?.creditsGranted).toBe(120);
    });

    it('looks up the pro pack (₦2000/300 credits) server-side', async () => {
      const res = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ pack: 'pro' });

      expect([200, 201]).toContain(res.status);
      const config = res.body.data.flutterwaveConfig;
      expect(config.amount).toBe(2000);

      const stored = await prisma.creditPurchase.findFirst({
        where: { flutterwaveTxRef: config.txRef },
      });
      expect(stored?.creditsGranted).toBe(300);
    });

    it('400s on an invalid payload (unknown pack)', async () => {
      const res = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pack: 'mega' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field (client-supplied amount rejected)', async () => {
      await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pack: 'starter', amount: 1 })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/credits/purchase')
        .send({ pack: 'starter' })
        .expect(401);
    });
  });

  describe('POST /credits/purchase/verify', () => {
    it('verifies a successful charge, marks it completed, and credits the balance (200)', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pack: 'starter' });
      const { txRef } = initRes.body.data.flutterwaveConfig;

      const beforeState = await prisma.creditsState.findUnique({
        where: { userWawuId: USER_PLAIN },
      });
      const beforeBalance = beforeState?.creditBalance ?? 0;

      const verifyRes = await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'flw-tx-12345', tx_ref: txRef });

      expect([200, 201]).toContain(verifyRes.status);
      expect(verifyRes.body.data).toEqual({
        creditBalance: beforeBalance + 50,
      });

      const stored = await prisma.creditPurchase.findFirst({
        where: { flutterwaveTxRef: txRef },
      });
      expect(stored?.status).toBe('completed');

      const state = await prisma.creditsState.findUnique({
        where: { userWawuId: USER_PLAIN },
      });
      expect(state?.creditBalance).toBe(beforeBalance + 50);
    });

    it('is idempotent on re-verification of an already-completed purchase (does not double-credit)', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ pack: 'starter' });
      const { txRef } = initRes.body.data.flutterwaveConfig;

      const firstRes = await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ transaction_id: 'flw-tx-repeat', tx_ref: txRef });
      expect([200, 201]).toContain(firstRes.status);
      const balanceAfterFirst = firstRes.body.data.creditBalance;

      const secondRes = await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ transaction_id: 'flw-tx-repeat-again', tx_ref: txRef });

      expect([200, 201]).toContain(secondRes.status);
      expect(secondRes.body.data).toEqual({ creditBalance: balanceAfterFirst });
    });

    it('marks the CreditPurchase failed and 400s when Flutterwave reports failure', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/credits/purchase')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pack: 'popular' });
      const { txRef } = initRes.body.data.flutterwaveConfig;

      const verifyRes = await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: MOCK_FAILURE_TRANSACTION_ID, tx_ref: txRef })
        .expect(400);

      expect(verifyRes.body.data).toBeNull();

      const stored = await prisma.creditPurchase.findFirst({
        where: { flutterwaveTxRef: txRef },
      });
      expect(stored?.status).toBe('failed');
    });

    it('404s for a tx_ref with no matching pending purchase for this caller', async () => {
      const res = await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          transaction_id: 'flw-tx-unknown',
          tx_ref: 'never-initialized-tx-ref',
        })
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('400s on an invalid payload (missing tx_ref)', async () => {
      const res = await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'flw-tx-12345' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/credits/purchase/verify')
        .send({ transaction_id: 'flw-tx-12345', tx_ref: 'whatever' })
        .expect(401);
    });
  });
});
