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
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const ADMIN_KEY = 'legal-ops-contract-spec-key';

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
  let previousAdminKey: string | undefined;

  const createdIds: string[] = [];

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
    previousAdminKey = process.env.WAWU_ADMIN_KEY;
    process.env.WAWU_ADMIN_KEY = ADMIN_KEY;

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
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, LegalModule],
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
      await prisma.legalRequest.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (app) await app.close();
    if (previousAdminKey === undefined) delete process.env.WAWU_ADMIN_KEY;
    else process.env.WAWU_ADMIN_KEY = previousAdminKey;
  });

  describe('the operator key gates every ops route', () => {
    it('401s with no operator key', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${crypto.randomUUID()}/cancel`)
        .send({ reason: 'Client asked us to stop.' })
        .expect(401);
    });

    it('401s with the wrong operator key', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/legal/ops/requests')
        .set('x-wawu-admin-key', 'not-the-key')
        .expect(401);
    });

    it('a user token is not an operator key', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/legal/ops/requests')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
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
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ amountNaira: 50_000 })
        .expect(400);
    });

    it('404s on a request that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${crypto.randomUUID()}/quote`)
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ notes: 'Scope agreed: two supplier contracts.' })
        .expect(200);
      expect(done.body.data.status).toBe('consultation_done');

      // The whole point: the ladder continues from here.
      const quoted = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/quote`)
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({})
        .expect(409);
    });

    it('400s when no consultation was ever paid for', async () => {
      const record = await seed({ status: 'consultation_scheduled' });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/consultation/complete`)
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ deliverableUrl: 'https://storage.wawu.test/x.pdf' })
        .expect(409);
    });

    it('400s without a deliverable link', async () => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/deliver`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({})
        .expect(400);
    });
  });

  describe('POST /legal/ops/requests/:id/cancel', () => {
    it('cancels with a reason the client can read', async () => {
      const record = await seed({ status: 'in_progress', servicePaidAt: new Date() });

      const res = await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ reason: 'no' })
        .expect(400);
    });

    it('409s on an already-delivered matter', async () => {
      const record = await seed({ status: 'delivered', deliveredAt: new Date() });
      await request(app.getHttpServer())
        .post(`/api/hub/legal/ops/requests/${record.id}/cancel`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ reason: 'Client changed their mind about it.' })
        .expect(409);
    });
  });

  describe('GET /legal/ops/requests', () => {
    it('lists the queue for one status', async () => {
      const record = await seed({ status: 'awaiting_quote', path: 'simple' });
      const res = await request(app.getHttpServer())
        .get('/api/hub/legal/ops/requests?status=awaiting_quote')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(200);

      expect(res.body.data.every((r: { status: string }) => r.status === 'awaiting_quote')).toBe(true);
      expect(res.body.data.some((r: { id: string }) => r.id === record.id)).toBe(true);
    });

    it('400s on a status that is not a real one', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/legal/ops/requests?status=made-up')
        .set('x-wawu-admin-key', ADMIN_KEY)
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
        .set('x-wawu-admin-key', ADMIN_KEY)
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
