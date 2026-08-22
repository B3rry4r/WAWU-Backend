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
import { LegalModule } from '../legal.module';

/**
 * WAWU Legal — the transitions that had no caller.
 *
 * Before this, `LegalService.quote()` was unreachable (no route called it),
 * `consultation_scheduled` was terminal after a paid consultation fee, and
 * `in_progress` — fully-paid legal work — could never become `delivered` or
 * `cancelled`. Every test here walks a state the customer could previously
 * enter and never leave.
 *
 * Paid states are seeded straight into the database rather than reached
 * through checkout: `FLUTTERWAVE_SECRET_KEY` is deliberately empty in this
 * sandbox, so `FlutterwaveCheckoutVerifier` cannot confirm anything and the
 * payment legs are not what is under test here.
 *
 * ── WHAT CHANGED IN THIS FILE, AND WHY ───────────────────────────────────
 * Every ops request below used to authenticate with `x-wawu-admin-key` — one
 * shared static secret, no identity, no roles. A dashboard agent measured the
 * consequence: a `support` admin correctly refused the KYC queue could reach
 * these routes and cancel a fully-paid matter or set the ₦ figure a client is
 * billed, with nothing attributable to a person. The routes now sit behind
 * AdminAuthGuard + AdminRolesGuard and this suite asserts the matrix per
 * handler:
 *
 *   GET requests                      — superadmin, support, finance (reviewer 403)
 *   consultation/complete, deliver    — superadmin, support          (finance, reviewer 403)
 *   quote, cancel                     — superadmin, finance          (support, reviewer 403)
 *
 * The old header is asserted DEAD rather than quietly dropped.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');

/** Still configured, so the assertion below proves a CORRECT key opens nothing. */
const RETIRED_KEY = 'legal-ops-contract-spec-key';

const QUEUE_ROLES = ['superadmin', 'support', 'finance'] as const;
const LIFECYCLE_ROLES = ['superadmin', 'support'] as const;
const MONEY_ROLES = ['superadmin', 'finance'] as const;

const ADMINS = adminFixtures('1e110000', 'legal-ops');
const SECRETS = adminJwtSecrets('legal-ops');

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
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('WAWU Legal ops lifecycle (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuIdProcess: ChildProcess | undefined;
  let token: string;
  let userId: string;
  let tokens: AdminTokens;
  const envSnapshot: Record<string, string | undefined> = {};

  const createdIds: string[] = [];

  const http = () => request(app.getHttpServer());

  /** Seeds a request straight into a state the payment legs would produce. */
  async function seed(data: Record<string, unknown>) {
    const record = await prisma.legalRequest.create({
      data: {
        wawuUserId: userId,
        serviceCode: 'contract-drafting',
        serviceName: 'Contract drafting',
        category: 'Contracts',
        path: 'consultation',
        status: 'draft',
        ...data,
      } as never,
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
    token = await loginAs('user@test.wawu.dev');
    userId = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
    ).sub as string;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        LegalModule,
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
      await prisma.legalRequest.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (prisma) await deleteAdminFixtures(prisma, ADMINS);
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('the admin identity gates every ops route', () => {
    it('401s with no credential at all', async () => {
      await http()
        .post(`/api/hub/legal/ops/requests/${crypto.randomUUID()}/cancel`)
        .send({ reason: 'Client asked us to stop.' })
        .expect(401);
    });

    it('a WAWU ID user token is not an admin session', async () => {
      await http()
        .get('/api/hub/legal/ops/requests')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('the retired x-wawu-admin-key header alone no longer opens anything', async () => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });
      await http().get('/api/hub/legal/ops/requests').set('x-wawu-admin-key', RETIRED_KEY).expect(401);
      await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set('x-wawu-admin-key', RETIRED_KEY)
        .send({ reason: 'A held key should not be able to do this.' })
        .expect(401);
      const unchanged = await prisma.legalRequest.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('in_progress');
    });

    it('a garbage bearer token is not an admin session', async () => {
      await http()
        .get('/api/hub/legal/ops/requests')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
    });
  });

  /**
   * The measured defect, closed. Before this change a `support` admin — the
   * role deliberately refused the KYC queue — could set a ₦ quote and cancel a
   * fully-paid matter here, because there was no role model to refuse them.
   */
  describe('the role matrix', () => {
    it.each(QUEUE_ROLES)('%s can read the queue', async (role) => {
      await http().get('/api/hub/legal/ops/requests').set(bearer(tokens[role])).expect(200);
    });

    it.each(rolesOtherThan(QUEUE_ROLES))('%s is refused the queue', async (role) => {
      await http().get('/api/hub/legal/ops/requests').set(bearer(tokens[role])).expect(403);
    });

    it.each(rolesOtherThan(MONEY_ROLES))('%s cannot set a price, and none is written', async (role) => {
      const record = await seed({ status: 'awaiting_quote', path: 'simple' });
      await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/quote`)
        .set(bearer(tokens[role]))
        .send({ amountNaira: 500_000 })
        .expect(403);
      const unchanged = await prisma.legalRequest.findUnique({ where: { id: record.id } });
      expect(unchanged?.quoteAmount).toBeNull();
      expect(unchanged?.status).toBe('awaiting_quote');
    });

    it.each(rolesOtherThan(MONEY_ROLES))('%s cannot cancel a paid matter', async (role) => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });
      await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set(bearer(tokens[role]))
        .send({ reason: 'This role has no business closing paid work.' })
        .expect(403);
      const unchanged = await prisma.legalRequest.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('in_progress');
      expect(unchanged?.cancelledAt).toBeNull();
    });

    it.each(rolesOtherThan(LIFECYCLE_ROLES))('%s cannot deliver work', async (role) => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });
      await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/deliver`)
        .set(bearer(tokens[role]))
        .send({ deliverableUrl: 'https://storage.wawu.test/legal/x.pdf' })
        .expect(403);
      const unchanged = await prisma.legalRequest.findUnique({ where: { id: record.id } });
      expect(unchanged?.deliverableUrl).toBeNull();
    });

    it.each(rolesOtherThan(LIFECYCLE_ROLES))('%s cannot close out a consultation', async (role) => {
      const record = await seed({
        status: 'consultation_scheduled',
        consultationMedium: 'zoom',
        consultationFee: 45_000,
        consultationPaidAt: new Date(),
      });
      await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/consultation/complete`)
        .set(bearer(tokens[role]))
        .send({})
        .expect(403);
      const unchanged = await prisma.legalRequest.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('consultation_scheduled');
    });
  });

  describe('attribution', () => {
    it('records who priced a matter, and keeps it off the client-facing response', async () => {
      const record = await seed({ status: 'awaiting_quote', path: 'simple' });
      const finance = ADMINS.find((a) => a.role === 'finance')!;

      const res = await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/quote`)
        .set(bearer(tokens.finance))
        .send({ amountNaira: 250_000, note: 'Two supplier contracts.' })
        .expect(200);

      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'legal_request', resourceId: record.id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'legal_quoted',
        subjectWawuId: userId,
        actedByAdminId: finance.id,
        actedByAdminEmail: finance.email,
        actedByAdminRole: 'finance',
      });
      // The ₦ figure itself is on the trail, not just the fact of a quote.
      expect(trail[0].detail).toMatchObject({ amountNaira: 250_000 });
      // LegalRequest reaches the client through toResponse(); no staff
      // identity may ride along on it.
      expect(JSON.stringify(res.body.data)).not.toContain('@admin.test.wawu.dev');
      expect(JSON.stringify(res.body.data)).not.toContain(finance.id);
    });

    it('records who cancelled a paid matter, with what had been paid', async () => {
      const record = await seed({
        status: 'in_progress',
        quoteAmount: 120_000,
        consultationPaidAt: new Date(),
        servicePaidAt: new Date(),
      });
      await http()
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set(bearer(tokens.superadmin))
        .send({ reason: 'Conflict of interest on the counterparty check.' })
        .expect(200);

      const trail = await prisma.adminOpsAudit.findMany({
        where: { resource: 'legal_request', resourceId: record.id, action: 'legal_cancelled' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0].detail).toMatchObject({
        servicePaid: true,
        consultationPaid: true,
        quoteAmount: 120_000,
      });
    });
  });

  describe('POST /legal/ops/requests/:id/quote', () => {
    it('prices an awaiting_quote request — the state that could never be left', async () => {
      const record = await seed({
        serviceCode: 'tax-registration',
        serviceName: 'Tax registration',
        category: 'Business Services',
        path: 'simple',
        status: 'awaiting_quote',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/quote`)
        .set(bearer(tokens.finance))
        .send({ amountNaira: 75_000, note: 'Includes the TIN filing.' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'quoted',
        quoteAmount: 75_000,
        quoteNote: 'Includes the TIN filing.',
      });
    });

    it('refuses to quote a consultation nobody has paid for', async () => {
      const record = await seed({ status: 'awaiting_consultation_payment' });

      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/quote`)
        .set(bearer(tokens.finance))
        .send({ amountNaira: 50_000 })
        .expect(400);
    });

    it('404s on a request that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${crypto.randomUUID()}/quote`)
        .set(bearer(tokens.finance))
        .send({ amountNaira: 1000 })
        .expect(404);
    });
  });

  describe('POST /legal/ops/requests/:id/consultation/complete', () => {
    it('moves a paid consultation_scheduled to consultation_done and can then be quoted', async () => {
      const record = await seed({
        status: 'consultation_scheduled',
        consultationMedium: 'zoom',
        consultationFee: 45_000,
        consultationPaidAt: new Date(),
        scheduledFor: new Date(Date.now() + 86_400_000),
      });

      const done = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/consultation/complete`)
        .set(bearer(tokens.support))
        .send({ notes: 'Scope agreed: two supplier contracts.' })
        .expect(200);
      expect(done.body.data.status).toBe('consultation_done');

      // The whole point: the ladder continues from here.
      const quoted = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/quote`)
        .set(bearer(tokens.finance))
        .send({ amountNaira: 120_000 })
        .expect(200);
      expect(quoted.body.data).toMatchObject({ status: 'quoted', quoteAmount: 120_000 });

      const stored = await prisma.legalRequest.findUnique({ where: { id: record.id } });
      expect(stored?.consultationNotes).toBe('Scope agreed: two supplier contracts.');
    });

    it('409s from any other status', async () => {
      const record = await seed({ status: 'in_progress', consultationPaidAt: new Date() });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/consultation/complete`)
        .set(bearer(tokens.support))
        .send({})
        .expect(409);
    });

    it('400s when no consultation was ever paid for', async () => {
      const record = await seed({ status: 'consultation_scheduled' });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/consultation/complete`)
        .set(bearer(tokens.support))
        .send({})
        .expect(400);
    });
  });

  describe('POST /legal/ops/requests/:id/deliver', () => {
    it('delivers fully-paid work — in_progress had no exit at all', async () => {
      const record = await seed({
        status: 'in_progress',
        quoteAmount: 120_000,
        contractSignedAt: new Date(),
        contractSignedAs: 'Adaeze Okeke',
        servicePaidAt: new Date(),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/deliver`)
        .set(bearer(tokens.support))
        .send({ deliverableUrl: 'https://storage.wawu.test/legal/contract-drafting.pdf' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'delivered',
        deliverableUrl: 'https://storage.wawu.test/legal/contract-drafting.pdf',
      });
      expect(res.body.data.deliveredAt).toEqual(expect.any(String));
    });

    it('409s on anything that is not in_progress', async () => {
      const record = await seed({ status: 'quoted', quoteAmount: 10_000 });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/deliver`)
        .set(bearer(tokens.support))
        .send({ deliverableUrl: 'https://storage.wawu.test/x.pdf' })
        .expect(409);
    });

    it('400s without a deliverable link', async () => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/deliver`)
        .set(bearer(tokens.support))
        .send({})
        .expect(400);
    });
  });

  describe('POST /legal/ops/requests/:id/cancel', () => {
    it('cancels with a reason the client can read', async () => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });

      const res = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set(bearer(tokens.finance))
        .send({ reason: 'Conflict of interest found on the counterparty check.' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'cancelled',
        cancellationReason: 'Conflict of interest found on the counterparty check.',
      });
      expect(res.body.data.cancelledAt).toEqual(expect.any(String));
    });

    it('requires a real reason', async () => {
      const record = await seed({ status: 'quoted', quoteAmount: 1000 });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set(bearer(tokens.finance))
        .send({ reason: 'no' })
        .expect(400);
    });

    it('409s on an already-delivered matter', async () => {
      const record = await seed({ status: 'delivered', deliveredAt: new Date() });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set(bearer(tokens.finance))
        .send({ reason: 'Client changed their mind about it.' })
        .expect(409);
    });
  });

  describe('GET /legal/ops/requests', () => {
    it('lists the queue for one status', async () => {
      const record = await seed({ status: 'awaiting_quote', path: 'simple' });
      const res = await request(app.getHttpServer())
        .get('/api/hub/legal/ops/requests?status=awaiting_quote')
        .set(bearer(tokens.support))
        .expect(200);

      expect(res.body.data.every((r: { status: string }) => r.status === 'awaiting_quote')).toBe(true);
      expect(res.body.data.some((r: { id: string }) => r.id === record.id)).toBe(true);
    });

    it('400s on a status that is not a real one', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/legal/ops/requests?status=made-up')
        .set(bearer(tokens.support))
        .expect(400);
    });
  });

  describe('the consultation calendar', () => {
    /** The first free slot the availability endpoint is offering. */
    async function firstFreeSlot(): Promise<string> {
      const res = await request(app.getHttpServer())
        .get('/api/hub/legal/availability')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      for (const day of res.body.data.days) {
        for (const slot of day.slots) if (slot.available) return slot.startsAt;
      }
      throw new Error('no free consultation slot on the calendar');
    }

    async function slotIsAvailable(startsAt: string): Promise<boolean> {
      const res = await request(app.getHttpServer())
        .get('/api/hub/legal/availability')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      for (const day of res.body.data.days) {
        for (const slot of day.slots) if (slot.startsAt === startsAt) return slot.available;
      }
      throw new Error(`slot ${startsAt} is not on the calendar`);
    }

    it('books the hour the client picked — it used to be dropped on the floor', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/hub/legal/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ serviceCode: 'contract-drafting' })
        .expect(201);
      createdIds.push(created.body.data.id);

      const slot = await firstFreeSlot();
      const booked = await request(app.getHttpServer())
        .post(`/api/hub/legal/requests/${created.body.data.id}/consultation`)
        .set('Authorization', `Bearer ${token}`)
        .send({ medium: 'chat', scheduledFor: slot })
        .expect(200);

      // `scheduledFor` was validated, clash-checked and then never written.
      expect(booked.body.data.request.scheduledFor).toBe(slot);
      expect(await slotIsAvailable(slot)).toBe(false);
    });

    it('gives the hour back when the booking is cancelled', async () => {
      const slot = await firstFreeSlot();
      const record = await seed({
        status: 'consultation_scheduled',
        consultationMedium: 'chat',
        consultationFee: 25_000,
        consultationPaidAt: new Date(),
        scheduledFor: new Date(slot),
      });
      expect(await slotIsAvailable(slot)).toBe(false);

      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set(bearer(tokens.finance))
        .send({ reason: 'Client rescheduled to a later date.' })
        .expect(200);

      // Abandoned bookings used to hold a lawyer's hour permanently.
      expect(await slotIsAvailable(slot)).toBe(true);
    });

    it('an unpaid booking older than the hold window stops blocking the hour', async () => {
      const slot = await firstFreeSlot();
      const stale = new Date(Date.now() - 60 * 60_000);
      const record = await seed({
        status: 'awaiting_consultation_payment',
        consultationMedium: 'chat',
        consultationFee: 25_000,
        scheduledFor: new Date(slot),
      });
      // `updatedAt` is @updatedAt, so age it directly.
      await prisma.$executeRawUnsafe(
        'UPDATE "LegalRequest" SET "updatedAt" = $1 WHERE "id" = $2',
        stale,
        record.id,
      );

      expect(await slotIsAvailable(slot)).toBe(true);
    });
  });
});
