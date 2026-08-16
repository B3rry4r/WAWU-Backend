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
import { PurchaseModule } from '../purchase.module';
import { MOCK_FAILURE_TRANSACTION_ID } from '../mock-flutterwave.adapter';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic tier, subscriptionPaid, kyc pending
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro tier, subscriptionPaid, kyc approved
const NONEXISTENT_WAWU_ID = 'ffffffff-0000-4000-8000-000000000099';

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

describe('Purchase (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorBasicToken: string;
  let creatorProToken: string;

  beforeAll(async () => {
    // Reuse an already-running mock WAWU ID if present, otherwise spawn one
    // for this test run (conventions.md § Local test environment).
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
        PurchaseModule,
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
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('POST /tips', () => {
    it('creates a pending tip and returns flutterwaveConfig for a Basic-tier creator (200/201, 0.15 commission)', async () => {
      const res = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          creatorWawuId: USER_CREATOR_BASIC,
          amount: 500,
          note: 'Nice content!',
        });

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

      const stored = await prisma.purchase.findFirst({
        where: { flutterwaveTxRef: config.txRef },
      });
      expect(stored).not.toBeNull();
      expect(stored?.type).toBe('tip');
      expect(stored?.contentId).toBeNull();
      expect(stored?.buyerWawuId).toBe(USER_PLAIN);
      expect(stored?.creatorWawuId).toBe(USER_CREATOR_BASIC);
      expect(stored?.status).toBe('pending');
      expect(stored?.note).toBe('Nice content!');
      expect(Number(stored?.commissionRate)).toBeCloseTo(0.15);
    });

    it('snapshots the 0.10 Pro-tier commission rate for an active Pro creator', async () => {
      const res = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ creatorWawuId: USER_CREATOR_PRO, amount: 1000 });

      expect([200, 201]).toContain(res.status);
      const config = res.body.data.flutterwaveConfig;

      const stored = await prisma.purchase.findFirst({
        where: { flutterwaveTxRef: config.txRef },
      });
      expect(Number(stored?.commissionRate)).toBeCloseTo(0.1);
    });

    it('rejects tipping yourself (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 500 })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('404s when the recipient does not exist', async () => {
      const res = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ creatorWawuId: NONEXISTENT_WAWU_ID, amount: 500 })
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('400s on an invalid payload (non-positive amount)', async () => {
      const res = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 0 })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          creatorWawuId: USER_CREATOR_BASIC,
          amount: 500,
          flutterwaveTxId: 'hax',
        })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/tips')
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 500 })
        .expect(401);
    });
  });

  describe('POST /tips/verify', () => {
    it('verifies a successful charge and marks the Purchase completed (200)', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 250 });
      const { txRef } = initRes.body.data.flutterwaveConfig;

      const verifyRes = await request(app.getHttpServer())
        .post('/tips/verify')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ transaction_id: 'flw-tx-12345', tx_ref: txRef });

      expect([200, 201]).toContain(verifyRes.status);
      expect(verifyRes.body.data).toEqual({ tipped: true });

      const stored = await prisma.purchase.findFirst({
        where: { flutterwaveTxRef: txRef },
      });
      expect(stored?.status).toBe('completed');
      expect(stored?.flutterwaveTxId).toBe('flw-tx-12345');
    });

    it('is idempotent on re-verification of an already-completed tip', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 250 });
      const { txRef } = initRes.body.data.flutterwaveConfig;

      const firstRes = await request(app.getHttpServer())
        .post('/tips/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'flw-tx-repeat', tx_ref: txRef });
      expect([200, 201]).toContain(firstRes.status);

      const secondRes = await request(app.getHttpServer())
        .post('/tips/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'flw-tx-repeat-again', tx_ref: txRef });

      expect([200, 201]).toContain(secondRes.status);
      expect(secondRes.body.data).toEqual({ tipped: true });
    });

    it('marks the Purchase failed and 400s when Flutterwave reports failure', async () => {
      const initRes = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ creatorWawuId: USER_CREATOR_PRO, amount: 750 });
      const { txRef } = initRes.body.data.flutterwaveConfig;

      const verifyRes = await request(app.getHttpServer())
        .post('/tips/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: MOCK_FAILURE_TRANSACTION_ID, tx_ref: txRef })
        .expect(400);

      expect(verifyRes.body.data).toBeNull();

      const stored = await prisma.purchase.findFirst({
        where: { flutterwaveTxRef: txRef },
      });
      expect(stored?.status).toBe('failed');
    });

    it('404s for a tx_ref with no matching pending tip for this caller', async () => {
      const res = await request(app.getHttpServer())
        .post('/tips/verify')
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
        .post('/tips/verify')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'flw-tx-12345' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/tips/verify')
        .send({ transaction_id: 'flw-tx-12345', tx_ref: 'whatever' })
        .expect(401);
    });
  });
});
