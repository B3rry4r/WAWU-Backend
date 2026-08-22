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
 */

const ADMIN_KEY = 'bills-ops-contract-spec-key';
const BUYER = '00000000-0000-4000-8000-000000000001';

describe('WAWUPay ops (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousAdminKey: string | undefined;
  const createdIds: string[] = [];

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
    previousAdminKey = process.env.WAWU_ADMIN_KEY;
    process.env.WAWU_ADMIN_KEY = ADMIN_KEY;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, BillPaymentModule],
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
      await prisma.billPayment.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (app) await app.close();
    if (previousAdminKey === undefined) delete process.env.WAWU_ADMIN_KEY;
    else process.env.WAWU_ADMIN_KEY = previousAdminKey;
  });

  it('401s without the operator key', async () => {
    const record = await seed('failed');
    await request(app.getHttpServer())
      .post(`/api/hub/bills/ops/${record.id}/record-refund`)
      .send({ refundReference: 'FLW-REFUND-1' })
      .expect(401);
  });

  describe('GET /bills/ops/stuck', () => {
    it('shows money taken and nothing delivered', async () => {
      const stuck = await seed('paid', new Date(Date.now() - 60 * 60_000));
      const failed = await seed('failed');
      const fine = await seed('delivered');

      const res = await request(app.getHttpServer())
        .get('/api/hub/bills/ops/stuck')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(200);

      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining([stuck.id, failed.id]));
      expect(ids).not.toContain(fine.id);
    });

    it('leaves a freshly-paid bill alone — delivery may still be in flight', async () => {
      const justNow = await seed('paid');
      const res = await request(app.getHttpServer())
        .get('/api/hub/bills/ops/stuck')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).not.toContain(justNow.id);
    });
  });

  describe('POST /bills/ops/:id/record-refund', () => {
    it('makes `refunded` reachable from paid', async () => {
      const record = await seed('paid');
      const res = await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-88213' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'refunded',
        refundReference: 'FLW-REFUND-88213',
      });
      expect(res.body.data.refundedAt).toEqual(expect.any(String));
    });

    it('makes `refunded` reachable from failed — the state the copy promises a refund for', async () => {
      const record = await seed('failed');
      const res = await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-88214' })
        .expect(200);
      expect(res.body.data.status).toBe('refunded');
    });

    it('refuses to record a refund with no real-world reference', async () => {
      const record = await seed('failed');
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({})
        .expect(400);

      const unchanged = await prisma.billPayment.findUnique({ where: { id: record.id } });
      expect(unchanged?.status).toBe('failed');
    });

    it('400s on a bill nobody has paid for', async () => {
      const record = await seed('pending');
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(400);
    });

    it('400s on a bill that was actually delivered', async () => {
      const record = await seed('delivered');
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(400);
    });

    it('409s on a second refund of the same bill', async () => {
      const record = await seed('failed');
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-A' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-B' })
        .expect(409);
    });

    it('404s on a bill that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${randomUUID()}/record-refund`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ refundReference: 'FLW-REFUND-1' })
        .expect(404);
    });
  });

  describe('POST /bills/ops/:id/reconcile', () => {
    it('is a no-op on a bill that is not stuck, without calling the provider', async () => {
      const record = await seed('delivered');
      const res = await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${record.id}/reconcile`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(200);
      expect(res.body.data).toMatchObject({ changed: false, providerStatus: null });
      expect(res.body.data.billPayment.status).toBe('delivered');
    });

    it('404s on a bill that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/bills/ops/${randomUUID()}/reconcile`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .expect(404);
    });
  });
});
