// Force the test DB before anything else touches PrismaService.
process.env.DATABASE_URL = process.env.DATABASE_URL?.includes('wawu_hub_test')
  ? process.env.DATABASE_URL
  : 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { resolveInternalServiceKey } from '../../common/tests/internal-service-key';
import {
  SHOP_RETIRED_CODE,
  SHOP_RETIRED_MESSAGE,
} from '../../shop/shop-retired';
import { PaymentLinkModule } from '../payment-link.module';

/**
 * WAWU Shop is retired (R-2, OPS-08): a Shop order can no longer be charged.
 *
 * `POST /payments/hosted-link` mints a Flutterwave payment page for a txRef
 * some flow already recorded. A pending Shop order from before the cutover
 * still has one, so without this refusal anybody holding such an order could
 * pay for it today and verify would mark it paid. What a user can do now:
 *
 *   - the buyer asking for a payment page for their old Shop order gets 410
 *     `shop_retired`, and Flutterwave is never called;
 *   - somebody else's Shop txRef is still a 404, so a ref cannot be probed;
 *   - every other flow's txRef still gets its page (the refusal is Shop only).
 *
 * A charge already opened before the cutover still settles through verify and
 * the webhook; that is covered in src/shop/tests/shop.contract.spec.ts.
 */

const BUYER_EMAIL = 'user@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';

// The mock WAWU ID is the one CI already started ("Start mock WAWU ID" in
// deploy.yml and branch-checks.yml), found at the port WAWU_ID_JWKS_URL names,
// as the other contract specs do (purchase.contract.spec.ts is the model). Only
// when none is up, on a bare local run, does this spec start one at that same
// port, and it stops only a mock it started itself.
//
// It used to start its own on 46000 + (pid % 3000), the same port as
// shop.contract.spec.ts: one fixed number for a whole `jest --runInBand` shard,
// inside the range the OS hands out for outgoing connections and listen(0).
// When anything held it, the new mock died on EADDRINUSE with nobody reading
// its output and every test failed in beforeAll with "did not become healthy
// in time" (the shop spec's failure in Deploy Hub API run 40206988479).
const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_URL = `http://127.0.0.1:${MOCK_WAWU_ID_PORT}`;
const TAG = `paylink-shop-${process.pid}`;
const FLUTTERWAVE_PAYMENTS = 'https://api.flutterwave.com/v3/payments';

// Set only when this spec started the mock itself.
let mockWawuId: ChildProcessWithoutNullStreams | undefined;
let mockWawuIdOutput = '';
let mockWawuIdExit: string | undefined;
let app: INestApplication;
let prisma: PrismaService;
let buyerToken: string;
let otherToken: string;
let productId: string;
let shopTxRef: string;
const realFetch = global.fetch;
/** Every request this suite's app sent to Flutterwave's payments endpoint. */
const flutterwaveCalls: string[] = [];
const envBefore = {
  secret: process.env.FLUTTERWAVE_SECRET_KEY,
  cors: process.env.CORS_ORIGIN,
};

async function waitForMock(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A mock this spec started that has already died will never answer.
    if (mockWawuIdExit) return false;
    try {
      const res = await realFetch(`${MOCK_WAWU_ID_URL}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function loginAs(identifier: string): Promise<string> {
  const res = await realFetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

function hostedLink(txRef: string, token: string) {
  return request(app.getHttpServer() as Server)
    .post('/api/hub/payments/hosted-link')
    .set('Authorization', `Bearer ${token}`)
    .send({
      txRef,
      title: 'WAWU',
      customerEmail: 'buyer@example.com',
      redirectUrl: 'https://app.wawu.test/payments/return',
    });
}

beforeAll(async () => {
  if (!(await waitForMock(1_000))) {
    mockWawuId = spawn(
      'node',
      [path.join(__dirname, '../../../mock-wawu-id/server.js')],
      {
        env: {
          ...process.env,
          MOCK_WAWU_ID_PORT,
          WAWU_ID_INTERNAL_SERVICE_KEY: resolveInternalServiceKey(),
        },
        stdio: 'pipe',
      },
    );
    // Keep what it says, so a mock that cannot start is named, not guessed at.
    const keep = (chunk: Buffer) => {
      mockWawuIdOutput = (mockWawuIdOutput + chunk.toString()).slice(-1_000);
    };
    mockWawuId.stdout.on('data', keep);
    mockWawuId.stderr.on('data', keep);
    mockWawuId.once('exit', (code, signal) => {
      mockWawuIdExit = `exited (${code ?? signal})`;
    });
    if (!(await waitForMock(15_000))) {
      throw new Error(
        `mock-wawu-id did not become healthy in time on port ${MOCK_WAWU_ID_PORT}` +
          ` (${mockWawuIdExit ?? 'still running'}): ${mockWawuIdOutput}`,
      );
    }
  }
  process.env.WAWU_ID_JWKS_URL = `${MOCK_WAWU_ID_URL}/.well-known/jwks.json`;
  process.env.WAWU_ID_BASE_URL = MOCK_WAWU_ID_URL;
  // A dummy key, so the control case reaches the (stubbed) provider call.
  process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST-ops08-dummy-X';
  delete process.env.CORS_ORIGIN;

  [buyerToken, otherToken] = await Promise.all([
    loginAs(BUYER_EMAIL),
    loginAs(OTHER_EMAIL),
  ]);

  // Flutterwave is answered here and only here; anything else goes through.
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === FLUTTERWAVE_PAYMENTS) {
      flutterwaveCalls.push(typeof init?.body === 'string' ? init.body : '');
      return new Response(
        JSON.stringify({
          status: 'success',
          data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/x' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      PaymentLinkModule,
    ],
  }).compile();
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

  const product = await prisma.product.create({
    data: {
      name: `${TAG} Ring light`,
      slug: `${TAG}-ring`,
      description: 'A ring light the shop stocked before it closed.',
      category: 'lighting_studio',
      subcategory: 'Ring lights',
      priceNaira: 20_000,
      stock: 4,
      images: ['https://cdn.example.com/ring.jpg'],
      status: 'live',
    },
  });
  productId = product.id;

  // Checkout opened this order before the shop closed; it was never paid.
  shopTxRef = `${TAG}-pending`;
  await prisma.shopOrder.create({
    data: {
      buyerWawuId: BUYER_SUB,
      status: 'pending',
      subtotalNaira: 20_000,
      totalNaira: 20_000,
      deliveryName: 'Bola Buyer',
      deliveryPhone: '+2348012345678',
      deliveryAddress: '12 Retired Close, Yaba',
      deliveryCity: 'Lagos',
      deliveryState: 'Lagos',
      flutterwaveTxRef: shopTxRef,
      createdAt: new Date(Date.now() - 20 * 24 * 3600 * 1000),
      items: {
        create: [
          {
            productId,
            nameSnapshot: `${TAG} Ring light`,
            priceNairaSnapshot: 20_000,
            quantity: 1,
          },
        ],
      },
    },
  });

  await prisma.pendingCharge.create({
    data: {
      txRef: `${TAG}-credits`,
      kind: 'credit-purchase',
      wawuUserId: BUYER_SUB,
      expectedAmount: 1_500,
      context: {},
    },
  });
}, 40_000);

beforeEach(() => {
  flutterwaveCalls.length = 0;
});

afterAll(async () => {
  global.fetch = realFetch;
  if (envBefore.secret === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
  else process.env.FLUTTERWAVE_SECRET_KEY = envBefore.secret;
  if (envBefore.cors !== undefined) process.env.CORS_ORIGIN = envBefore.cors;
  await prisma?.pendingCharge.deleteMany({
    where: { txRef: { startsWith: TAG } },
  });
  await prisma?.shopOrder.deleteMany({
    where: { flutterwaveTxRef: { startsWith: TAG } },
  });
  await prisma?.product.deleteMany({ where: { slug: { startsWith: TAG } } });
  await app?.close();
  mockWawuId?.kill();
});

describe('Shop retired: a Shop order cannot be charged any more', () => {
  it('the buyer cannot open a payment page for their old pending Shop order, and Flutterwave is never asked', async () => {
    const res = await hostedLink(shopTxRef, buyerToken);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      statusCode: 410,
      message: SHOP_RETIRED_MESSAGE,
      data: null,
      reason: { code: SHOP_RETIRED_CODE, message: SHOP_RETIRED_MESSAGE },
    });
    expect(flutterwaveCalls).toEqual([]);
    const order = await prisma.shopOrder.findUniqueOrThrow({
      where: { flutterwaveTxRef: shopTxRef },
    });
    expect(order.status).toBe('pending');
    expect(order.paidAt).toBeNull();
  });

  it("somebody else's Shop txRef is still a 404, so it cannot be probed", async () => {
    const res = await hostedLink(shopTxRef, otherToken);
    expect(res.status).toBe(404);
    expect(flutterwaveCalls).toEqual([]);
  });

  it('another flow still gets its payment page: the refusal is Shop only', async () => {
    const res = await hostedLink(`${TAG}-credits`, buyerToken);
    expect(res.status).toBe(200);
    expect((res.body as { data: { link: string } }).data.link).toMatch(
      /^https:\/\/checkout\.flutterwave\.com\//,
    );
    expect(flutterwaveCalls).toHaveLength(1);
    expect(JSON.parse(flutterwaveCalls[0])).toMatchObject({
      tx_ref: `${TAG}-credits`,
      amount: '1500',
    });
  });

  it('an unknown txRef is still a 404', async () => {
    const res = await hostedLink(`${TAG}-nothing`, buyerToken);
    expect(res.status).toBe(404);
    expect(flutterwaveCalls).toEqual([]);
  });
});
