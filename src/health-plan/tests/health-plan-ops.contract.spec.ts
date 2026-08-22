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
import { HealthPlanModule } from '../health-plan.module';

/**
 * WAWUCare — "our team will sort this out or refund you".
 *
 * Neither half of that promise had an implementation: nothing could re-attempt
 * a failed enrolment, and `FulfilmentStatus.refunded` had no writer at all, so
 * a buyer whose enrolment died after payment sat in `paid`/`failed` with no
 * route out and nothing looking for them.
 */

const ADMIN_KEY = 'care-ops-contract-spec-key';
const BUYER = '00000000-0000-4000-8000-000000000001';

describe('WAWUCare ops (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousAdminKey: string | undefined;
  const createdIds: string[] = [];

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
    previousAdminKey = process.env.WAWU_ADMIN_KEY;
    process.env.WAWU_ADMIN_KEY = ADMIN_KEY;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, HealthPlanModule],
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
      await prisma.healthSubscription.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (app) await app.close();
    if (previousAdminKey === undefined) delete process.env.WAWU_ADMIN_KEY;
    else process.env.WAWU_ADMIN_KEY = previousAdminKey;
  });

  it('401s without the operator key', async () => {
    const record = await seed('failed');
    await request(app.getHttpServer())
      .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
      .send({ refundReference: 'FLW-REFUND-1' })
      .expect(401);
  });

  describe('GET /care/ops/subscriptions/stuck', () => {
    it('shows everyone who paid for cover and does not have it', async () => {
      const stuck = await seed('paid', new Date(Date.now() - 60 * 60_000));
      const failed = await seed('failed');
      const enrolled = await seed('delivered');

      const res = await request(app.getHttpServer())
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(200);

      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining([stuck.id, failed.id]));
      expect(ids).not.toContain(enrolled.id);
    });
  });

  describe('POST /care/ops/subscriptions/:id/record-refund', () => {
    it('makes `refunded` reachable from paid', async () => {
      const record = await seed('paid');
      const res = await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-CARE-1' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'refunded',
        refundReference: 'FLW-REFUND-CARE-1',
      });
      expect(res.body.data.refundedAt).toEqual(expect.any(String));
    });

    it('refuses to record a refund with no real-world reference', async () => {
      const record = await seed('failed');
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({})
        .expect(400);
      const unchanged = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
    });

    it('400s on a subscription nobody has paid for', async () => {
      const record = await seed('pending');
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-CARE-2' })
        .expect(400);
    });

    it('409s on a second refund of the same subscription', async () => {
      const record = await seed('failed');
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-CARE-3' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-CARE-4' })
        .expect(409);
    });

    it('404s on a subscription that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${randomUUID()}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-CARE-5' })
        .expect(404);
    });
  });

  describe('POST /care/ops/subscriptions/:id/retry-enrolment', () => {
    /**
     * WELLAHEALTH_* is unset in this sandbox, so the partner call fails at the
     * config check. That is the interesting path anyway: a retry that fails
     * must leave the row visible and owed, not swallow it.
     */
    it('keeps a failed retry visible instead of losing it', async () => {
      const record = await seed('paid');
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/retry-enrolment`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(400);

      const after = await prisma.healthSubscription.findUnique({ where: { id: record.id } });
      expect(after?.status).toBe('failed');
      expect(after?.failureReason).toEqual(expect.any(String));

      const stuck = await request(app.getHttpServer())
        .get('/api/hub/care/ops/subscriptions/stuck')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(200);
      expect(stuck.body.data.map((r: { id: string }) => r.id)).toContain(record.id);
    });

    it('400s on a subscription that is already enrolled', async () => {
      const record = await seed('delivered');
      await request(app.getHttpServer())
        .post(`/api/hub/care/ops/subscriptions/${record.id}/retry-enrolment`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(400);
    });
  });
});
