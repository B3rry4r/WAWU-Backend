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
import { BillPaymentModule } from '../bill-payment.module';

/**
 * WAWUPay — `FulfilmentStatus.refunded` used to be unreachable.
 *
 * When a bill is paid for and the biller then rejects it, the customer is told
 * verbatim "our team will refund you". Nothing could record that refund
 * (`refunded` had no writer anywhere) and nothing could even find the rows it
 * applied to. These tests cover both halves, and the rule that keeps them
 * honest: the status may only be written against the reference of a refund a
 * human actually sent, because no adapter in this codebase can move money.
 *
 * ── WHAT CHANGED IN THIS FILE, AND WHY ───────────────────────────────────
 * Every request below used to authenticate with `x-wawu-admin-key` — one
 * shared static secret, no identity, no roles. The routes now sit behind
 * AdminAuthGuard + AdminRolesGuard, so the suite logs four real admins in
 * through the real `POST /admin/auth/login` and asserts the matrix per
 * handler:
 *
 *   GET stuck                 — superadmin, finance, support   (reviewer 403)
 *   reconcile, record-refund  — superadmin, finance            (support, reviewer 403)
 *
 * The old header is asserted DEAD rather than quietly dropped: a bypass that
 * still works is not a fix.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const BUYER = '00000000-0000-4000-8000-000000000001';

const STUCK_ROLES = ['superadmin', 'finance', 'support'] as const;
const MONEY_ROLES = ['superadmin', 'finance'] as const;

const ADMINS = adminFixtures('b1110000', 'bills-ops');
const SECRETS = adminJwtSecrets('bills-ops');

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('WAWUPay ops (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AdminTokens;
  let userToken: string;
  const createdIds: string[] = [];
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());

  async function seed(status: 'pending' | 'paid' | 'delivered' | 'failed', createdAt?: Date) {
    const record = await prisma.billPayment.create({
      data: {
        buyerWawuId: BUYER,
        category: 'AIRTIME',
        billerCode: 'BIL099',
        itemCode: 'AT099',
        billerName: 'MTN Airtime',
        customerRef: '08031234567',
        amount: 1_000,
        flutterwaveTxRef: `wawu-bill-spec-${randomUUID()}`,
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
    // Set to a REAL value on purpose: the point of the header assertion below
    // is that a correct operator key no longer opens anything. Leaving it
    // unset would prove only that an unconfigured guard fails closed.
    process.env.WAWU_ADMIN_KEY = 'bills-ops-contract-spec-key';

    userToken = await loginToWawuId('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        BillPaymentModule,
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
      await prisma.billPayment.deleteMany({ where: { id: { in: createdIds } } });
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
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(401);
    });

    it('a WAWU ID user token is not an admin session', async () => {
      await http().get('/api/hub/bills/ops/stuck').set(bearer(userToken)).expect(401);
    });

    it('the retired x-wawu-admin-key header alone no longer opens anything', async () => {
      const record = await seed('failed');
      await http().get('/api/hub/bills/ops/stuck').set('x-wawu-admin-key', 'bills-ops-contract-spec-key').expect(401);
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', 'bills-ops-contract-spec-key')
        .send({ refundReference: 'FLW-REFUND-KEY' })
        .expect(401);
      const unchanged = await prisma.billPayment.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
    });
  });

  describe('GET /bills/ops/stuck', () => {
    it.each(STUCK_ROLES)('%s can read the queue', async (role) => {
      await http().get('/api/hub/bills/ops/stuck').set(bearer(tokens[role])).expect(200);
    });

    it.each(rolesOtherThan(STUCK_ROLES))('%s is refused the queue', async (role) => {
      await http().get('/api/hub/bills/ops/stuck').set(bearer(tokens[role])).expect(403);
    });

    it('shows money taken and nothing delivered', async () => {
      const stuck = await seed('paid', new Date(Date.now() - 60 * 60_000));
      const failed = await seed('failed');
      const fine = await seed('delivered');

      const res = await http()
        .get('/api/hub/bills/ops/stuck')
        .set(bearer(tokens.finance))
        .expect(200);

      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining([stuck.id, failed.id]));
      expect(ids).not.toContain(fine.id);
    });

    it('leaves a freshly-paid bill alone — delivery may still be in flight', async () => {
      const justNow = await seed('paid');
      const res = await http()
        .get('/api/hub/bills/ops/stuck')
        .set(bearer(tokens.finance))
        .expect(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).not.toContain(justNow.id);
    });
  });

  describe('POST /bills/ops/:id/record-refund', () => {
    it.each(MONEY_ROLES)('%s can record a refund', async (role) => {
      const record = await seed('failed');
      const res = await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens[role]))
        .send({ refundReference: `FLW-REFUND-${role}` })
        .expect(200);
      expect(res.body.data.status).toBe('refunded');
    });

    it.each(rolesOtherThan(MONEY_ROLES))('%s cannot record a refund, and nothing moves', async (role) => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens[role]))
        .send({ refundReference: 'FLW-REFUND-NOPE' })
        .expect(403);
      const unchanged = await prisma.billPayment.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
      expect(unchanged?.refundReference).toBeNull();
    });

    it('makes `refunded` reachable from paid', async () => {
      const record = await seed('paid');
      const res = await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-88213' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'refunded',
        refundReference: 'FLW-REFUND-88213',
      });
      expect(res.body.data.refundedAt).toEqual(expect.any(String));
    });

    it('names the admin who recorded it — the action used to be anonymous', async () => {
      const record = await seed('failed');
      const finance = ADMINS.find((a) => a.role === 'finance')!;
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-AUDITED' })
        .expect(200);

      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'bill_payment', resourceId: record.id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'bill_refund_recorded',
        subjectWawuId: BUYER,
        actedByAdminId: finance.id,
        actedByAdminEmail: finance.email,
        actedByAdminRole: 'finance',
      });
      expect(trail[0].detail).toMatchObject({ refundReference: 'FLW-REFUND-AUDITED' });
    });

    it('is NOT written to the customer-facing row — the app response is unchanged', async () => {
      const record = await seed('failed');
      const res = await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-SHAPE' })
        .expect(200);
      // BillPayment is a bare Prisma re-export returned by spread, so an
      // actedByAdmin column on it would have shipped straight into the app.
      expect(Object.keys(res.body.data)).not.toContain('actedByAdminId');
      expect(JSON.stringify(res.body.data)).not.toContain('@admin.test.wawu.dev');
    });

    it('makes `refunded` reachable from failed — the state the copy promises a refund for', async () => {
      const record = await seed('failed');
      const res = await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-88214' })
        .expect(200);
      expect(res.body.data.status).toBe('refunded');
    });

    it('refuses to record a refund with no real-world reference', async () => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({})
        .expect(400);

      const unchanged = await prisma.billPayment.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
    });

    it('400s on a bill nobody has paid for', async () => {
      const record = await seed('pending');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(400);
    });

    it('400s on a bill that was actually delivered', async () => {
      const record = await seed('delivered');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(400);
    });

    it('409s on a second refund of the same bill', async () => {
      const record = await seed('failed');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-A' })
        .expect(200);
      await http()
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-B' })
        .expect(409);
    });

    it('404s on a bill that does not exist', async () => {
      await http()
        .post(`/api/hub/bills/ops/${randomUUID()}/record-refund`)
        .set(bearer(tokens.finance))
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(404);
    });
  });

  describe('POST /bills/ops/:id/reconcile', () => {
    it.each(MONEY_ROLES)('%s can reconcile', async (role) => {
      const record = await seed('delivered');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/reconcile`)
        .set(bearer(tokens[role]))
        .expect(200);
    });

    it.each(rolesOtherThan(MONEY_ROLES))('%s cannot reconcile', async (role) => {
      const record = await seed('delivered');
      await http()
        .post(`/api/hub/bills/ops/${record.id}/reconcile`)
        .set(bearer(tokens[role]))
        .expect(403);
    });

    it('is a no-op on a bill that is not stuck, without calling the provider', async () => {
      const record = await seed('delivered');
      const res = await http()
        .post(`/api/hub/bills/ops/${record.id}/reconcile`)
        .set(bearer(tokens.finance))
        .expect(200);
      expect(res.body.data).toMatchObject({ changed: false, providerStatus: null });
      expect(res.body.data.billPayment.status).toBe('delivered');
    });

    it('404s on a bill that does not exist', async () => {
      await http()
        .post(`/api/hub/bills/ops/${randomUUID()}/reconcile`)
        .set(bearer(tokens.finance))
        .expect(404);
    });
  });
});
