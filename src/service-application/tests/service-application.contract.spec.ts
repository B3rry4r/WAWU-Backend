import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { ServiceApplicationModule } from '../service-application.module';
import { MOCK_FLUTTERWAVE_FAIL_TXN_ID } from '../mock-flutterwave.adapter';

/**
 * Contract tests for registry.json § ServiceApplication —
 * GET /services/applications, GET /services/applications/:id,
 * POST /services/cac/apply, POST /services/cac/apply/verify,
 * POST /services/nepc/apply.
 *
 * Auth handshake: per conventions.md § Local test environment, this spins
 * up (or reuses, if another concurrently-running Phase 5 agent's suite
 * already has) the real mock-wawu-id service and performs a real HTTP login
 * against it, so tokens are genuinely RS256-signed and verified over JWKS
 * by WawuJwtStrategy — never minted/injected directly into the request.
 *
 * Flutterwave: MockFlutterwaveAdapter is wired in automatically by
 * ServiceApplicationModule (FLUTTERWAVE_SECRET_KEY is the .env-committed
 * placeholder in this sandbox — see module comment). No real Flutterwave
 * connectivity is exercised here, per declared/flutterwave-payments.json's
 * sandboxNote.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');

const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic creator, KYC pending

async function isMockWawuIdUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForMockWawuId(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isMockWawuIdUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('ServiceApplication contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuIdProcess: ChildProcess | undefined;

  let tokenPlain: string;
  let tokenCreatorBasic: string;

  const createdIds: string[] = [];

  beforeAll(async () => {
    if (!(await isMockWawuIdUp())) {
      mockWawuIdProcess = spawn('node', ['mock-wawu-id/server.js'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      mockWawuIdProcess.unref();
      await waitForMockWawuId();
    }

    [tokenPlain, tokenCreatorBasic] = await Promise.all([
      loginAs('user@test.wawu.dev'),
      loginAs('creator-basic@test.wawu.dev'),
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, ServiceApplicationModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
  }, 30_000);

  afterAll(async () => {
    if (prisma && createdIds.length) {
      await prisma.serviceApplication.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (app) await app.close();
    // Deliberately NOT killing mockWawuIdProcess — shared local dependency
    // other concurrently-running agents' test suites may still be using.
  });

  describe('POST /services/nepc/apply', () => {
    it('valid request -> 201 with the created ServiceApplication shape', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({
          rcNumber: 'RC-1234567',
          exportCategory: 'agro-processing',
          mainProduct: 'Shea butter',
          targetMarkets: ['UK', 'Germany'],
          yearlyVolume: '10 tonnes',
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        applicantWawuId: USER_PLAIN,
        kind: 'nepc',
        status: 'submitted',
      });
      expect(res.body.data.id).toEqual(expect.any(String));
      expect(res.body.data.reference).toMatch(/^WA-NEPC-\d{5}$/);
      expect(Array.isArray(res.body.data.timeline)).toBe(true);
      createdIds.push(res.body.data.id);
    });

    it('400s on an invalid payload (missing required field)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ rcNumber: 'RC-1', exportCategory: 'agro', mainProduct: 'Shea', targetMarkets: ['UK'] })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({
          rcNumber: 'RC-1',
          exportCategory: 'agro',
          mainProduct: 'Shea',
          targetMarkets: ['UK'],
          yearlyVolume: '1',
          extra: 'nope',
        })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).post('/api/hub/services/nepc/apply').send({}).expect(401);
    });
  });

  describe('POST /services/cac/apply + /services/cac/apply/verify', () => {
    it('apply -> 201 with a flutterwaveConfig, then verify -> 200/201 with the submitted ServiceApplication', async () => {
      const applyRes = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ registrationType: 'business-name', names: ['Adaeze Ventures', 'Adaeze Trading'], nature: 'Retail' });

      expect(applyRes.status).toBe(201);
      const config = applyRes.body.data.flutterwaveConfig;
      expect(config).toMatchObject({ amount: 25_000, currency: 'NGN' });
      expect(typeof config.txRef).toBe('string');
      expect(typeof config.publicKey).toBe('string');

      const verifyRes = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply/verify')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ transaction_id: 'FLW_TXN_12345', tx_ref: config.txRef });

      expect([200, 201]).toContain(verifyRes.status);
      expect(verifyRes.body.data).toMatchObject({
        applicantWawuId: USER_PLAIN,
        kind: 'cac',
        status: 'submitted',
        amountPaid: 25_000,
      });
      createdIds.push(verifyRes.body.data.id);

      const getRes = await request(app.getHttpServer())
        .get(`/api/hub/services/applications/${verifyRes.body.data.id}`)
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(200);
      expect(getRes.body.data.id).toBe(verifyRes.body.data.id);

      // Not this caller's application -> 404, never leaked to another user.
      await request(app.getHttpServer())
        .get(`/api/hub/services/applications/${verifyRes.body.data.id}`)
        .set('Authorization', `Bearer ${tokenCreatorBasic}`)
        .expect(404);
    });

    it('a simulated failed Flutterwave verification -> 400, application stays awaiting_payment', async () => {
      const applyRes = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ registrationType: 'business-name', names: ['Failing Co'], nature: 'Services' });
      const config = applyRes.body.data.flutterwaveConfig;

      const verifyRes = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply/verify')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ transaction_id: MOCK_FLUTTERWAVE_FAIL_TXN_ID, tx_ref: config.txRef });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.data).toBeNull();

      const applicationId = config.txRef.replace(/^cac-/, '');
      createdIds.push(applicationId);
      const row = await prisma.serviceApplication.findUnique({ where: { id: applicationId } });
      expect(row?.status).toBe('awaiting_payment');
    });

    it('400s on verify with an unrecognized tx_ref', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply/verify')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ transaction_id: 'FLW_TXN_999', tx_ref: 'not-a-cac-ref' })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('400s on apply with an invalid payload (empty names array)', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ registrationType: 'business-name', names: [], nature: 'Retail' })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).post('/api/hub/services/cac/apply').send({}).expect(401);
    });
  });

  describe('GET /services/applications', () => {
    it('returns only the caller\'s own applications, paginated (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/services/applications')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 20, total: expect.any(Number) }),
      );
      for (const item of res.body.data) {
        expect(item.applicantWawuId).toBe(USER_PLAIN);
      }
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/hub/services/applications').expect(401);
    });
  });

  describe('GET /services/applications/:id', () => {
    it('404s for a non-existent id', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/services/applications/ffffffff-0000-4000-8000-000000009999')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(404);
    });

    it('400s for a malformed id (non-UUID)', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/services/applications/not-a-uuid')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/hub/services/applications/ffffffff-0000-4000-8000-000000009999').expect(401);
    });
  });
});
