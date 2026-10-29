import { randomUUID } from 'crypto';
import type { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { FlutterwaveCheckoutVerifier } from '../../common/flutterwave/checkout-verifier';
import { BillPaymentModule } from '../bill-payment.module';
import { FlutterwaveBillsClient } from '../flutterwave-bills.client';

/**
 * BILLS-09 (R-102), on a real database and the real guard, with Flutterwave replaced by a counting stand-in (this spec
 * never reaches the provider).
 *
 *   - `GET /bills/:id/status`: the buyer's own bills only; another person's is a 404; a `processing` bill is asked about
 *     once in 20 seconds and two reads at once ask once and settle once;
 *   - `POST /bills/:id/verify` and `GET /bills/mine` answer what they answered, plus `token` and `units` (null when none).
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const TOKEN = '4821 0937 5510 2286 7734';

/** What `verify` and `mine` answered before BILLS-09, key for key. */
const OLD_KEYS = [
  'amount',
  'billerName',
  'category',
  'createdAt',
  'customerRef',
  'deliveredAt',
  'failureReason',
  'fee',
  'id',
  'providerReference',
  'refundReference',
  'refundedAt',
  'status',
];

type Answer = { body: unknown };
/** The `data` of a one-record answer. */
const one = (res: Answer) =>
  (res.body as { data: Record<string, unknown> }).data;
/** The `data` of a list answer. */
const many = (res: Answer) =>
  (res.body as { data: Record<string, unknown>[] }).data;

async function loginToWawuId(
  identifier: string,
): Promise<{ token: string; sub: string }> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  const token = ((await res.json()) as { accessToken: string }).accessToken;
  const sub = (
    JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string }
  ).sub;
  return { token, sub };
}

describe('BILLS-09: bill status, token and units (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let buyer: { token: string; sub: string };
  let other: { token: string; sub: string };
  const createdIds: string[] = [];
  const statusAnswer = jest.fn<Promise<unknown>, [string]>();
  const payAnswer = jest.fn<Promise<unknown>, []>();

  const http = () => request(app.getHttpServer() as Server);
  const auth = (t: { token: string }) => ({
    Authorization: `Bearer ${t.token}`,
  });

  async function seed(
    status: 'pending' | 'processing' | 'delivered' | 'failed',
    extra: Record<string, unknown> = {},
  ) {
    const record = await prisma.billPayment.create({
      data: {
        buyerWawuId: buyer.sub,
        category: 'POWER',
        billerCode: 'BIL112',
        itemCode: 'UB159',
        billerName: 'IKEDC PREPAID',
        customerRef: '45021234567',
        amount: 5000,
        flutterwaveTxRef: `wawu-bill-spec-${randomUUID()}`,
        providerReference: status === 'pending' ? null : 'FLW-REF-1',
        status,
        ...extra,
      },
    });
    createdIds.push(record.id);
    return record;
  }

  beforeAll(async () => {
    buyer = await loginToWawuId('user@test.wawu.dev');
    other = await loginToWawuId('creator-basic@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BillPaymentModule,
      ],
    })
      .overrideProvider(FlutterwaveBillsClient)
      .useValue({
        billStatus: (ref: string) => statusAnswer(ref),
        payBill: () => payAnswer(),
        availableNgn: () => Promise.resolve(null),
      })
      .overrideProvider(FlutterwaveCheckoutVerifier)
      .useValue({
        verify: () => Promise.resolve({ transactionId: 'flw-txn-1' }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
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
  }, 30_000);

  beforeEach(() => {
    statusAnswer.mockReset();
    payAnswer.mockReset();
  });

  afterAll(async () => {
    if (prisma && createdIds.length) {
      await prisma.billPayment.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
    if (app) await app.close();
  });

  describe('GET /bills/:id/status', () => {
    it('401s with no token', async () => {
      const bill = await seed('processing');
      await http().get(`/api/hub/bills/${bill.id}/status`).expect(401);
    });

    it("answers 404 for another person's bill, and never asks the provider", async () => {
      const bill = await seed('processing', {
        providerCheckedAt: new Date(Date.now() - 5 * 60_000),
      });
      statusAnswer.mockResolvedValue({ status: 'successful', token: TOKEN });
      await http()
        .get(`/api/hub/bills/${bill.id}/status`)
        .set(auth(other))
        .expect(404);
      expect(statusAnswer).not.toHaveBeenCalled();
      const after = await prisma.billPayment.findUnique({
        where: { id: bill.id },
      });
      expect(after?.status).toBe('processing');
      expect(after?.token).toBeNull();
    });

    it('answers 404 for a bill that does not exist and 400 for an id that is not a UUID', async () => {
      await http()
        .get(`/api/hub/bills/${randomUUID()}/status`)
        .set(auth(buyer))
        .expect(404);
      await http()
        .get('/api/hub/bills/wallet/status')
        .set(auth(buyer))
        .expect(400);
    });

    it('answers the bill: status, token, units and providerReference', async () => {
      const bill = await seed('delivered', {
        token: TOKEN,
        units: '45.2',
        deliveredAt: new Date(),
      });
      const res = await http()
        .get(`/api/hub/bills/${bill.id}/status`)
        .set(auth(buyer))
        .expect(200);
      expect(one(res)).toEqual({
        id: bill.id,
        status: 'delivered',
        token: TOKEN,
        units: '45.2',
        providerReference: 'FLW-REF-1',
      });
      expect(statusAnswer).not.toHaveBeenCalled();
    });

    it('a processing bill checked a moment ago is answered from the record', async () => {
      const bill = await seed('processing', {
        providerCheckedAt: new Date(Date.now() - 3_000),
      });
      const res = await http()
        .get(`/api/hub/bills/${bill.id}/status`)
        .set(auth(buyer))
        .expect(200);
      expect(one(res)).toMatchObject({
        status: 'processing',
        token: null,
        units: null,
      });
      expect(statusAnswer).not.toHaveBeenCalled();
    });

    it('a processing bill checked a while ago is asked about, settled and its token kept', async () => {
      const bill = await seed('processing', {
        providerCheckedAt: new Date(Date.now() - 60_000),
      });
      statusAnswer.mockResolvedValue({
        status: 'successful',
        token: TOKEN,
        extra: 'Units: 45.2',
      });

      const res = await http()
        .get(`/api/hub/bills/${bill.id}/status`)
        .set(auth(buyer))
        .expect(200);

      expect(one(res)).toMatchObject({
        status: 'delivered',
        token: TOKEN,
        units: '45.2',
        providerReference: 'FLW-REF-1',
      });
      expect(statusAnswer).toHaveBeenCalledTimes(1);
      expect(statusAnswer).toHaveBeenCalledWith(bill.flutterwaveTxRef);
      const row = await prisma.billPayment.findUnique({
        where: { id: bill.id },
      });
      expect(row?.status).toBe('delivered');
      expect(row?.deliveredAt).toBeInstanceOf(Date);
      expect(row?.token).toBe(TOKEN);
      expect(row?.providerCheckedAt).toBeInstanceOf(Date);
    });

    it('five reads at once ask the provider once and settle once; a sixth afterwards asks nobody', async () => {
      const bill = await seed('processing', {
        providerCheckedAt: new Date(Date.now() - 60_000),
      });
      statusAnswer.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { status: 'successful', token: TOKEN };
      });

      const reads = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          http().get(`/api/hub/bills/${bill.id}/status`).set(auth(buyer)),
        ),
      );

      for (const r of reads) {
        expect(r.status).toBe(200);
        expect(['processing', 'delivered']).toContain(one(r).status);
      }
      expect(statusAnswer).toHaveBeenCalledTimes(1);
      const row = await prisma.billPayment.findUnique({
        where: { id: bill.id },
      });
      expect(row?.status).toBe('delivered');
      expect(row?.token).toBe(TOKEN);

      const later = await http()
        .get(`/api/hub/bills/${bill.id}/status`)
        .set(auth(buyer))
        .expect(200);
      expect(one(later)).toMatchObject({
        status: 'delivered',
        token: TOKEN,
      });
      expect(statusAnswer).toHaveBeenCalledTimes(1);
    });

    it('a provider that cannot be reached is answered from the record with a 200', async () => {
      const bill = await seed('processing', {
        providerCheckedAt: new Date(Date.now() - 60_000),
      });
      statusAnswer.mockRejectedValue(
        new Error('Could not reach the bill payment provider.'),
      );
      const res = await http()
        .get(`/api/hub/bills/${bill.id}/status`)
        .set(auth(buyer))
        .expect(200);
      expect(one(res).status).toBe('processing');
    });
  });

  describe('verify and mine keep their answers and gain token and units', () => {
    it('verify: every old key, plus token and units from the purchase answer', async () => {
      const bill = await seed('pending');
      payAnswer.mockResolvedValue({
        reference: 'FLW-REF-9',
        code: '00',
        fee: 0,
        recharge_token: TOKEN,
        extra: 'Units: 45.2',
      });

      const res = await http()
        .post(`/api/hub/bills/${bill.id}/verify`)
        .set(auth(buyer))
        .send({ transactionId: 'flw-txn-1' })
        .expect(200);

      expect(Object.keys(one(res)).sort()).toEqual(
        [...OLD_KEYS, 'token', 'units'].sort(),
      );
      expect(one(res)).toMatchObject({
        status: 'processing',
        providerReference: 'FLW-REF-9',
        token: TOKEN,
        units: '45.2',
      });
    });

    it('verify: token and units are null (present) for a bill that carries none', async () => {
      const bill = await seed('pending', { category: 'AIRTIME' });
      payAnswer.mockResolvedValue({
        reference: 'FLW-REF-8',
        code: '00',
        fee: 10,
        recharge_token: null,
      });
      const res = await http()
        .post(`/api/hub/bills/${bill.id}/verify`)
        .set(auth(buyer))
        .send({ transactionId: 'flw-txn-1' })
        .expect(200);
      expect(one(res)).toHaveProperty('token', null);
      expect(one(res)).toHaveProperty('units', null);
    });

    it('mine: every old key on each item, plus token and units', async () => {
      await seed('delivered', { token: TOKEN, units: '45.2' });
      await seed('delivered', { category: 'AIRTIME' });
      const res = await http()
        .get('/api/hub/bills/mine')
        .set(auth(buyer))
        .expect(200);
      expect(Array.isArray(many(res))).toBe(true);
      expect(many(res).length).toBeGreaterThanOrEqual(2);
      for (const item of many(res)) {
        expect(Object.keys(item).sort()).toEqual(
          [...OLD_KEYS, 'token', 'units'].sort(),
        );
      }
      expect(many(res).some((i) => i.token === TOKEN)).toBe(true);
      expect(many(res).some((i) => i.token === null)).toBe(true);
      expect((res.body as { pagination?: unknown }).pagination).toBeDefined();
    });

    it("mine lists only the caller's bills", async () => {
      const res = await http()
        .get('/api/hub/bills/mine')
        .set(auth(other))
        .expect(200);
      const ids = many(res).map((i) => i.id as string);
      expect(ids.filter((id) => createdIds.includes(id))).toEqual([]);
    });
  });
});
