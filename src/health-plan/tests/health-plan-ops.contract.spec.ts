import { randomUUID } from 'crypto';
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
import { HealthPlanModule } from '../health-plan.module';

/**
 * WAWUCare — "our team will sort this out or refund you".
 *
 * Neither half of that promise had an implementation: nothing could re-attempt
 * a failed enrolment, and `FulfilmentStatus.refunded` had no writer at all, so
 * a buyer whose enrolment died after payment sat in `paid`/`failed` with no
 * route out and nothing looking for them.
 *
 * ── WHAT CHANGED IN THIS FILE, AND WHY ───────────────────────────────────
 * These routes moved off `x-wawu-admin-key` — one shared static secret, no
 * identity, no roles — onto AdminAuthGuard + AdminRolesGuard. The matrix under
 * test:
 *
 *   GET subscriptions/stuck             — superadmin, finance, support  (reviewer 403)
 *   retry-enrolment, record-refund      — superadmin, finance           (support, reviewer 403)
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const BUYER = '00000000-0000-4000-8000-000000000001';

const STUCK_ROLES = ['superadmin', 'finance', 'support'] as const;
const MONEY_ROLES = ['superadmin', 'finance'] as const;

const ADMINS = adminFixtures('c1110000', 'care-ops');
const SECRETS = adminJwtSecrets('care-ops');
const RETIRED_KEY = 'care-ops-contract-spec-key';

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('WAWUCare ops (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AdminTokens;
  let userToken: string;
  const createdIds: string[] = [];
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());

  async function seed(
    status: 'pending' | 'paid' | 'delivered' | 'failed',
    createdAt?: Date,
  ) {
    const record = await prisma.healthSubscription.create({
      data: {
        wawuUserId: BUYER,
        planCode: 'ZOI-BASIC',
        planName: 'Zoi Basic',
        price: 600,
        phoneNumber: '08031234567',
        firstName: 'Ada',
        lastName: 'Okeke',
        gender: 'Female',
        dateOfBirth: '1994-05-21',
        flutterwaveTxRef: `wawu-care-spec-${randomUUID()}`,
        status,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    createdIds.push(record.id);
    return record;
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET', 'WAWU_ADMIN_KEY']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;
    // A REAL key on purpose: the assertion below is that a CORRECT operator
    // key opens nothing, not that an unconfigured guard fails closed.
    process.env.WAWU_ADMIN_KEY = RETIRED_KEY;

    userToken = await loginToWawuId('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        HealthPlanModule,
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
      await prisma.healthSubscription.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (prisma) {
      await prisma.adminOpsAudit.deleteMany({
        where: { actedByAdminId: { in: ADMINS.map((a) => a.id) } },
      });
      await deleteAdminFixtures(prisma, ADMINS);
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('the admin identity gates every ops route', () => {
    it('401s with no credential at all', async () => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(401);
    });

    it('a WAWU ID user token is not an admin session', async () => {
      await http()
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set(bearer(userToken))
        .expect(401);
    });

    it('the retired x-wawu-admin-key header alone no longer opens anything', async () => {
      const record = await seed('failed');
      await http()
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set('x-wawu-admin-key', RETIRED_KEY)
        .expect(401);
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set('x-wawu-admin-key', RETIRED_KEY)
        .send({ refundReference: 'FLW-REFUND-KEY' })
        .expect(401);
      const unchanged = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
    });
  });

  describe('GET /care/ops/subscriptions/stuck', () => {
    it.each(STUCK_ROLES)('%s can read the queue', async (role) => {
      await http()
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set(bearer(tokens[role]))
        .expect(200);
    });

    it.each(rolesOtherThan(STUCK_ROLES))('%s is refused the queue', async (role) => {
      await http()
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set(bearer(tokens[role]))
        .expect(403);
    });

    it('shows everyone who paid for cover and does not have it', async () => {
      const stuck = await seed('paid', new Date(Date.now() - 60 * 60_000));
      const failed = await seed('failed');
      const enrolled = await seed('delivered');

      const res = await http()
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set(bearer(tokens.finance))
        .expect(200);

      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining([stuck.id, failed.id]));
      expect(ids).not.toContain(enrolled.id);
    });
  });

  describe('POST /care/ops/subscriptions/:id/record-refund', () => {
    it.each(MONEY_ROLES)('%s can record a refund', async (role) => {
      const record = await seed('failed');
      const res = await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens[role]))
        .send({ refundReference: `FLW-REFUND-CARE-${role}` })
        .expect(200);
      expect(res.body.data.status).toBe('refunded');
    });

    it.each(rolesOtherThan(MONEY_ROLES))('%s cannot record a refund, and nothing moves', async (role) => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens[role]))
        .send({ refundReference: 'FLW-REFUND-CARE-NOPE' })
        .expect(403);
      const unchanged = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
      expect(unchanged?.refundReference).toBeNull();
    });

    it('makes `refunded` reachable from paid', async () => {
      const record = await seed('paid');
      const res = await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-CARE-1' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'refunded',
        refundReference: 'FLW-REFUND-CARE-1',
      });
      expect(res.body.data.refundedAt).toEqual(expect.any(String));
    });

    it('names the admin who recorded it, and keeps that out of the buyer-facing row', async () => {
      const record = await seed('failed');
      const finance = ADMINS.find((a) => a.role === 'finance')!;
      const res = await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-CARE-AUDITED' })
        .expect(200);

      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'health_subscription', resourceId: record.id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'care_refund_recorded',
        subjectWawuId: BUYER,
        actedByAdminId: finance.id,
        actedByAdminRole: 'finance',
      });
      // HealthSubscription is a bare Prisma re-export returned by spread.
      expect(JSON.stringify(res.body.data)).not.toContain('@admin.test.wawu.dev');
    });

    it('refuses to record a refund with no real-world reference', async () => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({})
        .expect(400);
      const unchanged = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
    });

    it('400s on a subscription nobody has paid for', async () => {
      const record = await seed('pending');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-CARE-2' })
        .expect(400);
    });

    it('409s on a second refund of the same subscription', async () => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-CARE-3' })
        .expect(200);
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-CARE-4' })
        .expect(409);
    });

    it('404s on a subscription that does not exist', async () => {
      await http()
        .post(`/api/hub/care/ops/subscriptions/${randomUUID()}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-CARE-5' })
        .expect(404);
    });
  });

  describe('POST /care/ops/subscriptions/:id/retry-enrolment', () => {
    it.each(rolesOtherThan(MONEY_ROLES))('%s cannot retry an enrolment', async (role) => {
      const record = await seed('paid');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/retry-enrolment`)
        .set(bearer(tokens[role]))
        .expect(403);
      // A 403 must be refused BEFORE the partner is called, not after.
      const unchanged = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('paid');
    });

    /**
     * WELLAHEALTH_* is unset in this sandbox, so the partner call fails at the
     * config check. That is the interesting path anyway: a retry that fails
     * must leave the row visible and owed, not swallow it.
     */
    it('keeps a failed retry visible instead of losing it, and audits the attempt', async () => {
      const record = await seed('paid');
      const finance = ADMINS.find((a) => a.role === 'finance')!;
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/retry-enrolment`)
        .set(bearer(tokens.finance))
        .expect(400);

      const after = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(after?.status).toBe('failed');
      expect(after?.failureReason).toEqual(expect.any(String));

      // A failed retry is still a named admin asking a partner to enrol a
      // paying customer, so it is on the trail rather than only the happy path.
      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'health_subscription', resourceId: record.id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'care_enrolment_retried',
        actedByAdminId: finance.id,
      });
      expect(trail[0].detail).toMatchObject({ outcome: 'failed' });

      const stuck = await http()
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set(bearer(tokens.finance))
        .expect(200);
      expect(stuck.body.data.map((r: { id: string }) => r.id)).toContain(record.id);
    });

    it('400s on a subscription that is already enrolled', async () => {
      const record = await seed('delivered');
      await http()
        .post(`/api/hub/care/ops/subscriptions/${record.id}/retry-enrolment`)
        .set(bearer(tokens.finance))
        .expect(400);
    });
  });
});
