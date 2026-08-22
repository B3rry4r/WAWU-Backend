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
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  rolesOtherThan,
  seedAdminFixtures,
  type AdminTokens,
} from '../../common/tests/admin-session.helper';
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
/**
 * Still configured, so the assertion in "operator progression" proves that a
 * CORRECT operator key opens nothing — not merely that an unconfigured guard
 * fails closed. These three routes moved off AdminKeyGuard (one shared static
 * secret, no identity, no roles) onto AdminAuthGuard + AdminRolesGuard:
 *
 *   progress, reject, approve  — superadmin, support  (reviewer, finance 403)
 */
const RETIRED_KEY = 'service-application-contract-spec-key';

const OPS_ROLES = ['superadmin', 'support'] as const;

const ADMINS = adminFixtures('5a110000', 'service-app-ops');
const SECRETS = adminJwtSecrets('service-app-ops');

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
  let tokens: AdminTokens;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET', 'WAWU_ADMIN_KEY']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;
    process.env.WAWU_ADMIN_KEY = RETIRED_KEY;

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
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        ServiceApplicationModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    await seedAdminFixtures(prisma, ADMINS);
    tokens = await loginAllAdmins(app, ADMINS);
  }, 30_000);

  afterAll(async () => {
    if (prisma && createdIds.length) {
      await prisma.adminOpsAudit.deleteMany({ where: { resourceId: { in: createdIds } } });
      await prisma.serviceApplication.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (prisma) await deleteAdminFixtures(prisma, ADMINS);
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  /**
   * The shipped web app posts pension/loan applications to
   * `/api/hub/service-applications/partner/apply`
   * (WAWU-Web `src/lib/api/lifestyle.ts` → `applyForPartnerService`), a path
   * that has never existed — every other call in that file uses the
   * `services/` prefix. Pension registration 404'd for every user. The alias
   * accepts what the shipped client sends; the canonical route is unchanged.
   */
  describe('POST /service-applications/partner/apply (alias for the shipped app)', () => {
    it('the path the app actually calls now resolves', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/service-applications/partner/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ kind: 'pension', note: 'I want to open an ARM pension account.' })
        .expect(201);

      expect(res.body.data).toMatchObject({ kind: 'pension', title: 'Pensions' });
      expect(res.body.data.reference).toMatch(/^WA-PEN-\d{5}$/);
      createdIds.push(res.body.data.id);
    });

    it('the canonical path still works and behaves identically', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/partner/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ kind: 'pension', note: 'Same request, canonical path.' })
        .expect(201);
      expect(res.body.data).toMatchObject({ kind: 'pension', title: 'Pensions' });
      createdIds.push(res.body.data.id);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/service-applications/partner/apply')
        .send({ kind: 'pension', note: 'No token on this one.' })
        .expect(401);
    });
  });

  describe('the applicant\'s own words survive', () => {
    it('keeps the partner-service note instead of discarding it', async () => {
      const note = 'I run a shea butter export business and want a pension I can pay into monthly.';
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/partner/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ kind: 'pension', note, documents: ['https://storage.wawu.test/id.pdf'] })
        .expect(201);
      createdIds.push(res.body.data.id);

      // `note` passed a @MinLength(10) check and was then written nowhere at
      // all. It now lands in the timeline entry the tracking screen reads.
      const notes = (res.body.data.timeline as { note?: string }[]).map((t) => t.note);
      expect(notes).toContain(note);
      expect(res.body.data.documents).toEqual(['https://storage.wawu.test/id.pdf']);
    });

    it('keeps the NEPC documents the apply screen forces the applicant to upload', async () => {
      const documents = [
        'https://storage.wawu.test/nepc/cac-certificate.pdf',
        'https://storage.wawu.test/nepc/sample.jpg',
        'https://storage.wawu.test/nepc/bank-reference.pdf',
      ];
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({
          rcNumber: 'RC-7742119',
          exportCategory: 'Agro commodities',
          mainProduct: 'Shea butter',
          targetMarkets: ['UK'],
          yearlyVolume: '10 tonnes',
          documents,
        })
        .expect(201);
      createdIds.push(res.body.data.id);

      expect(res.body.data.documents).toEqual(documents);
    });

    it('still accepts a NEPC application with no documents (the shipped client sends none)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({
          rcNumber: 'RC-1',
          exportCategory: 'Agro',
          mainProduct: 'Shea',
          targetMarkets: ['UK'],
          yearlyVolume: '1 tonne',
        })
        .expect(201);
      createdIds.push(res.body.data.id);
      expect(res.body.data.documents).toEqual([]);
    });
  });

  describe('the CAC certificate date', () => {
    it('is set when payment is verified — the success screen used to render "By "', async () => {
      const applied = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ registrationType: 'business-name', names: ['Okeke Farms Enugu'], nature: 'Agriculture' })
        .expect(201);

      const verified = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply/verify')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ transaction_id: 'FLW_TXN_54321', tx_ref: applied.body.data.flutterwaveConfig.txRef });

      expect([200, 201]).toContain(verified.status);
      createdIds.push(verified.body.data.id);

      expect(verified.body.data.certificateExpectedBy).toEqual(expect.any(String));
      const expected = new Date(verified.body.data.certificateExpectedBy);
      expect(expected.getTime()).toBeGreaterThan(Date.now());
    });
  });

  /**
   * An application only ever reached `submitted`/`under_review`: nothing
   * appended to `timeline`, nothing set `rejection`, nothing set
   * `certificateExpectedBy`. The tracking screen could not show a date or a
   * refusal because no code path could produce one.
   */
  describe('operator progression', () => {
    async function anApplication(): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({
          rcNumber: 'RC-OPS',
          exportCategory: 'Agro',
          mainProduct: 'Shea',
          targetMarkets: ['UK'],
          yearlyVolume: '2 tonnes',
        })
        .expect(201);
      createdIds.push(res.body.data.id);
      return res.body.data.id as string;
    }

    it('401s with no credential at all', async () => {
      const id = await anApplication();
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/progress`)
        .send({ label: 'Under review' })
        .expect(401);
    });

    it('a WAWU ID user token is not an admin session', async () => {
      const id = await anApplication();
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/progress`)
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ label: 'Under review' })
        .expect(401);
    });

    it('the retired x-wawu-admin-key header alone no longer opens anything', async () => {
      const id = await anApplication();
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/progress`)
        .set('x-wawu-admin-key', RETIRED_KEY)
        .send({ label: 'Under review' })
        .expect(401);

      const unchanged = await prisma.serviceApplication.findUnique({ where: { id } });
      expect((unchanged?.timeline as unknown[]).length).toBe(1);
    });

    it.each(OPS_ROLES)('%s can work an application', async (role) => {
      const id = await anApplication();
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/progress`)
        .set(bearer(tokens[role]))
        .send({ label: 'Under review' })
        .expect(200);
    });

    it.each(rolesOtherThan(OPS_ROLES))('%s cannot move an application at all', async (role) => {
      const id = await anApplication();
      for (const [path, body] of [
        ['progress', { label: 'Under review' }],
        ['reject', { reason: 'A role with no claim on this queue.' }],
        ['approve', {}],
      ] as const) {
        await request(app.getHttpServer())
          .post(`/api/hub/services/ops/applications/${id}/${path}`)
          .set(bearer(tokens[role]))
          .send(body)
          .expect(403);
      }
      const unchanged = await prisma.serviceApplication.findUnique({ where: { id } });
      expect(unchanged?.status).toBe('submitted');
      expect((unchanged?.timeline as unknown[]).length).toBe(1);
    });

    it('names the admin who refused it, without putting them in the applicant\'s timeline', async () => {
      const id = await anApplication();
      const support = ADMINS.find((a) => a.role === 'support')!;
      const reason = 'Your bank reference letter is older than three months.';

      const res = await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/reject`)
        .set(bearer(tokens.support))
        .send({ reason })
        .expect(200);

      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'service_application', resourceId: id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'application_rejected',
        subjectWawuId: USER_PLAIN,
        actedByAdminId: support.id,
        actedByAdminEmail: support.email,
        actedByAdminRole: 'support',
      });

      // `timeline` is what the APPLICANT reads, and ServiceApplication is a
      // bare Prisma re-export returned by spread — no staff identity may reach
      // either.
      expect(JSON.stringify(res.body.data)).not.toContain('@admin.test.wawu.dev');
      expect(JSON.stringify(res.body.data)).not.toContain(support.id);
    });

    it('appends a timeline step and can set the expected certificate date', async () => {
      const id = await anApplication();
      const res = await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/progress`)
        .set(bearer(tokens.support))
        .send({
          label: 'Under review',
          note: 'An export agent is checking your documents.',
          status: 'under_review',
          statusLabel: 'Under review',
          certificateExpectedBy: '2026-09-04',
        })
        .expect(200);

      expect(res.body.data).toMatchObject({ status: 'under_review', statusLabel: 'Under review' });
      expect(res.body.data.certificateExpectedBy).toContain('2026-09-04');
      expect(res.body.data.timeline).toHaveLength(2);
      expect(res.body.data.timeline[1]).toMatchObject({
        label: 'Under review',
        note: 'An export agent is checking your documents.',
      });
    });

    it('records a refusal the applicant can read', async () => {
      const id = await anApplication();
      const reason = 'Your bank reference letter is older than three months.';
      const res = await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/reject`)
        .set(bearer(tokens.support))
        .send({ reason })
        .expect(200);

      expect(res.body.data).toMatchObject({ status: 'rejected', rejection: reason });
      expect(res.body.data.timeline.at(-1)).toMatchObject({ note: reason });
    });

    it('refuses a rejection with no reason', async () => {
      const id = await anApplication();
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/reject`)
        .set(bearer(tokens.support))
        .send({ reason: 'no' })
        .expect(400);
    });

    it('approves and attaches the issued certificate', async () => {
      const id = await anApplication();
      const res = await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/approve`)
        .set(bearer(tokens.support))
        .send({
          note: 'Download it from your services list.',
          certificateUrl: 'https://storage.wawu.test/nepc/certificate.pdf',
        })
        .expect(200);

      expect(res.body.data).toMatchObject({ status: 'approved', statusLabel: 'Certificate ready' });
      expect(res.body.data.documents).toContain('https://storage.wawu.test/nepc/certificate.pdf');
    });

    it('404s on an application that does not exist', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/services/ops/applications/ffffffff-0000-4000-8000-000000009999/progress')
        .set(bearer(tokens.support))
        .send({ label: 'Under review' })
        .expect(404);
    });

    it('the applicant sees the progression on their own tracking read', async () => {
      const id = await anApplication();
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/progress`)
        .set(bearer(tokens.support))
        .send({ label: 'Names checked', status: 'under_review', statusLabel: 'Under review' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/hub/services/applications/${id}`)
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(200);
      expect(res.body.data.statusLabel).toBe('Under review');
      expect(res.body.data.timeline.at(-1).label).toBe('Names checked');
    });
  });
  /**
   * THE GAP THESE CLOSE. `progress`, `reject` and `approve` all take an
   * application id, and until now nothing an operator could reach supplied
   * one: the only two reads on the resource are scoped to the caller's own
   * `applicantWawuId`, so an operator running either saw their own
   * applications and nothing else. CAC and NEPC registrations people had paid
   * 25,000 naira for sat in a queue with no door.
   *
   * The queue's own status filter is what isolates these assertions from every
   * other suite's rows on the shared, deliberately non-parallel test database:
   * the fixtures below are stamped with a status no other suite writes, so
   * "oldest first" and "total" are asserted over a known set.
   */
  describe('GET /services/ops/applications (the operator queue)', () => {
    const QUEUE_STATUS = 'ops-queue-spec';
    /** Oldest first, and the oldest belongs to the OTHER applicant. */
    const OLDEST = new Date('2026-01-05T09:00:00.000Z');
    const MIDDLE = new Date('2026-02-05T09:00:00.000Z');
    const NEWEST = new Date('2026-03-05T09:00:00.000Z');

    let idOldestOtherApplicant: string;
    let idMiddle: string;
    let idNewest: string;

    async function anApplicationFor(token: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${token}`)
        .send({
          rcNumber: 'RC-QUEUE',
          exportCategory: 'Agro',
          mainProduct: 'Shea',
          targetMarkets: ['UK'],
          yearlyVolume: '4 tonnes',
        })
        .expect(201);
      createdIds.push(res.body.data.id);
      return res.body.data.id as string;
    }

    beforeAll(async () => {
      // Any earlier crashed run of this suite would otherwise leave rows
      // carrying QUEUE_STATUS behind and make the counts below lie.
      await prisma.serviceApplication.deleteMany({
        where: { status: QUEUE_STATUS },
      });

      idOldestOtherApplicant = await anApplicationFor(tokenCreatorBasic);
      idMiddle = await anApplicationFor(tokenPlain);
      idNewest = await anApplicationFor(tokenPlain);

      for (const [id, appliedDate] of [
        [idOldestOtherApplicant, OLDEST],
        [idMiddle, MIDDLE],
        [idNewest, NEWEST],
      ] as const) {
        await prisma.serviceApplication.update({
          where: { id },
          data: { status: QUEUE_STATUS, appliedDate },
        });
      }
    });

    const queue = (query: Record<string, unknown>, token: string) =>
      request(app.getHttpServer())
        .get('/api/hub/services/ops/applications')
        .query(query)
        .set(bearer(token));

    it("lists applications from EVERY applicant, not just the caller's, oldest first", async () => {
      const res = await queue(
        { status: QUEUE_STATUS, perPage: 50 },
        tokens.support,
      ).expect(200);

      expect(res.body.data.map((i: { id: string }) => i.id)).toEqual([
        idOldestOtherApplicant,
        idMiddle,
        idNewest,
      ]);
      // The row at the front of the queue is not the caller's and not even the
      // applicant most of this suite's fixtures belong to — which is the whole
      // point: a self-scoped read showed an operator none of these.
      expect(res.body.data[0].applicantWawuId).toBe(USER_CREATOR_BASIC);
      expect(
        new Set(
          res.body.data.map(
            (i: { applicantWawuId: string }) => i.applicantWawuId,
          ),
        ),
      ).toEqual(new Set([USER_CREATOR_BASIC, USER_PLAIN]));
    });

    it('sort=newest flips it, so the default really is a choice', async () => {
      const res = await queue(
        { status: QUEUE_STATUS, perPage: 50, sort: 'newest' },
        tokens.support,
      ).expect(200);
      expect(res.body.data.map((i: { id: string }) => i.id)).toEqual([
        idNewest,
        idMiddle,
        idOldestOtherApplicant,
      ]);
    });

    it('reports a real total, not the length of the page it returned', async () => {
      const res = await queue(
        { status: QUEUE_STATUS, perPage: 2 },
        tokens.support,
      ).expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({
        currentPage: 1,
        nextPage: 2,
        perPage: 2,
        total: 3,
      });

      const page2 = await queue(
        { status: QUEUE_STATUS, perPage: 2, page: 2 },
        tokens.support,
      ).expect(200);
      expect(page2.body.data.map((i: { id: string }) => i.id)).toEqual([
        idNewest,
      ]);
      expect(page2.body.pagination).toMatchObject({
        currentPage: 2,
        nextPage: null,
        total: 3,
      });
    });

    it('filters by service kind', async () => {
      const nepc = await queue(
        { status: QUEUE_STATUS, kind: 'nepc', perPage: 50 },
        tokens.support,
      ).expect(200);
      expect(nepc.body.data).toHaveLength(3);

      const cac = await queue(
        { status: QUEUE_STATUS, kind: 'cac', perPage: 50 },
        tokens.support,
      ).expect(200);
      expect(cac.body.data).toHaveLength(0);
      expect(cac.body.pagination.total).toBe(0);
    });

    it('400s on a kind that is not a service', async () => {
      await queue({ kind: 'not-a-service' }, tokens.support).expect(400);
    });

    it('400s on an undeclared query parameter', async () => {
      await queue({ applicantWawuId: USER_PLAIN }, tokens.support).expect(400);
    });

    it('returns the declared queue shape, and no document URLs', async () => {
      const res = await queue(
        { status: QUEUE_STATUS, perPage: 50 },
        tokens.support,
      ).expect(200);
      const row = res.body.data[0];
      expect(row).toEqual({
        id: expect.any(String),
        reference: expect.stringMatching(/^WA-NEPC-\d{5}$/),
        applicantWawuId: USER_CREATOR_BASIC,
        kind: 'nepc',
        title: 'NEPC export registration',
        status: QUEUE_STATUS,
        statusLabel: 'Submitted — under review',
        appliedDate: OLDEST.toISOString(),
        waitingDays: expect.any(Number),
        amountPaid: null,
        documentCount: 0,
        certificateExpectedBy: null,
        latestUpdateLabel: 'Submitted',
      });
      // A declared view, not a spread of the row: the `documents` and
      // `timeline` columns are detail-only, which is what makes the audit
      // split below honest.
      expect(row).not.toHaveProperty('documents');
      expect(row).not.toHaveProperty('timeline');
    });

    it.each(OPS_ROLES)('%s can open the queue', async (role) => {
      await queue({ perPage: 1 }, tokens[role]).expect(200);
    });

    it.each(rolesOtherThan(OPS_ROLES))(
      '%s cannot open the queue',
      async (role) => {
        await queue({ perPage: 1 }, tokens[role]).expect(403);
      },
    );

    it('a WAWU ID user token is not an admin session, and no credential is 401', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/services/ops/applications')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/hub/services/ops/applications')
        .expect(401);
    });

    it('writes no audit row — a queue row discloses no document', async () => {
      const before = await prisma.adminOpsAudit.count({
        where: {
          resource: 'service_application',
          resourceId: { in: createdIds },
        },
      });
      await queue({ status: QUEUE_STATUS, perPage: 50 }, tokens.support).expect(
        200,
      );
      const after = await prisma.adminOpsAudit.count({
        where: {
          resource: 'service_application',
          resourceId: { in: createdIds },
        },
      });
      expect(after).toBe(before);
    });
  });

  describe('GET /services/ops/applications/:id (one application in full)', () => {
    const documents = [
      'https://storage.wawu.test/service-application/document/id-card.jpg',
      'https://storage.wawu.test/service-application/document/signature.png',
    ];
    const answers =
      'Shea butter export (Agro commodities) targeting UK, Germany. Yearly volume: 12 tonnes.';

    async function aDocumentedApplication(): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/api/hub/services/nepc/apply')
        .set('Authorization', `Bearer ${tokenCreatorBasic}`)
        .send({
          rcNumber: 'RC-DETAIL',
          exportCategory: 'Agro commodities',
          mainProduct: 'Shea butter',
          targetMarkets: ['UK', 'Germany'],
          yearlyVolume: '12 tonnes',
          documents,
        })
        .expect(201);
      createdIds.push(res.body.data.id);
      return res.body.data.id as string;
    }

    const detail = (id: string, token: string) =>
      request(app.getHttpServer())
        .get(`/api/hub/services/ops/applications/${id}`)
        .set(bearer(token));

    it("returns the applicant's own answers, their documents and the timeline", async () => {
      const id = await aDocumentedApplication();
      const res = await detail(id, tokens.support).expect(200);

      expect(res.body.data).toMatchObject({
        id,
        applicantWawuId: USER_CREATOR_BASIC,
        kind: 'nepc',
        documents,
        documentCount: 2,
        rejection: null,
        certificateExpectedBy: null,
        amountPaid: null,
      });
      // The submitted answers. They live in the intake timeline entry because
      // the schema has no column for them — surfaced as their own field rather
      // than left for the operator to dig out.
      expect(res.body.data.submission).toEqual({
        label: 'Submitted',
        occurredAt: expect.any(String),
        note: answers,
      });
      expect(res.body.data.timeline).toEqual([res.body.data.submission]);
    });

    it('shows a refused CAC application with what was paid and why it was refused', async () => {
      const applied = await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({
          registrationType: 'business-name',
          names: ['Ngozi Fabrics'],
          nature: 'Textiles',
          documents: [documents[0]],
        })
        .expect(201);
      const txRef = applied.body.data.flutterwaveConfig.txRef as string;
      const id = txRef.replace(/^cac-/, '');
      createdIds.push(id);

      await request(app.getHttpServer())
        .post('/api/hub/services/cac/apply/verify')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({ transaction_id: 'FLW_TXN_OPSREAD', tx_ref: txRef });

      const reason =
        'All three proposed names are already on the CAC register.';
      await request(app.getHttpServer())
        .post(`/api/hub/services/ops/applications/${id}/reject`)
        .set(bearer(tokens.support))
        .send({ reason })
        .expect(200);

      const res = await detail(id, tokens.support).expect(200);
      expect(res.body.data).toMatchObject({
        kind: 'cac',
        status: 'rejected',
        rejection: reason,
        // 25,000 naira, stranded — the figure an operator has to be able to
        // see next to the refusal.
        amountPaid: 25_000,
        documents: [documents[0]],
      });
      expect(res.body.data.certificateExpectedBy).toEqual(expect.any(String));
      expect(
        res.body.data.timeline.map((t: { label: string }) => t.label),
      ).toEqual(['Application started', 'Submitted', 'Not approved']);
    });

    it('survives a malformed timeline instead of 500ing the screen', async () => {
      const id = await aDocumentedApplication();
      // The column is Prisma `Json`; nothing in the type system rules this
      // out, and the failure mode of trusting it is the operator back to a
      // blank screen.
      await prisma.serviceApplication.update({
        where: { id },
        data: { timeline: { corrupted: true } as never },
      });

      const res = await detail(id, tokens.support).expect(200);
      expect(res.body.data.timeline).toEqual([]);
      expect(res.body.data.submission).toBeNull();
      expect(res.body.data.latestUpdateLabel).toBeNull();
    });

    it('records WHO opened it — the one read on this surface that is audited', async () => {
      const id = await aDocumentedApplication();
      const support = ADMINS.find((a) => a.role === 'support')!;

      await detail(id, tokens.support).expect(200);

      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'service_application', resourceId: id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'application_documents_viewed',
        subjectWawuId: USER_CREATOR_BASIC,
        actedByAdminId: support.id,
        actedByAdminEmail: support.email,
        actedByAdminRole: 'support',
      });
      expect(trail[0].detail).toMatchObject({ kind: 'nepc', documentCount: 2 });
    });

    it("never leaks the operator back to the applicant's own read", async () => {
      const id = await aDocumentedApplication();
      const support = ADMINS.find((a) => a.role === 'support')!;
      await detail(id, tokens.support).expect(200);

      const applicantView = await request(app.getHttpServer())
        .get(`/api/hub/services/applications/${id}`)
        .set('Authorization', `Bearer ${tokenCreatorBasic}`)
        .expect(200);
      expect(JSON.stringify(applicantView.body)).not.toContain(support.email);
      expect(JSON.stringify(applicantView.body)).not.toContain(support.id);
    });

    it.each(OPS_ROLES)('%s can open one application', async (role) => {
      const id = await aDocumentedApplication();
      await detail(id, tokens[role]).expect(200);
    });

    it.each(rolesOtherThan(OPS_ROLES))(
      '%s cannot open one application',
      async (role) => {
        const id = await aDocumentedApplication();
        await detail(id, tokens[role]).expect(403);

        const trail = await prisma.adminOpsAudit.count({
          where: { resource: 'service_application', resourceId: id },
        });
        expect(trail).toBe(0);
      },
    );

    it('404s on an id that is not an application, 400s on one that is not a uuid', async () => {
      await detail(
        'ffffffff-0000-4000-8000-000000009999',
        tokens.support,
      ).expect(404);
      await detail('not-a-uuid', tokens.support).expect(400);
    });

    it('a WAWU ID user token is not an admin session, and no credential is 401', async () => {
      const id = await aDocumentedApplication();
      await request(app.getHttpServer())
        .get(`/api/hub/services/ops/applications/${id}`)
        .set('Authorization', `Bearer ${tokenPlain}`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api/hub/services/ops/applications/${id}`)
        .expect(401);
    });
  });
});
