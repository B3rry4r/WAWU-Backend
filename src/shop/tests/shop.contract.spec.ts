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
import { AppController } from '../../app.controller';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { resolveInternalServiceKey } from '../../common/tests/internal-service-key';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { CreatorDiscoveryModule } from '../../creator-discovery/creator-discovery.module';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from '../../direct-message/flutterwave-client.interface';
import { SearchResponseModule } from '../../search-response/search-response.module';
import {
  CAMPAIGN_DESTINATIONS,
  isCampaignDestination,
} from '../../admin/notifications/campaign-destination';
import { ShopModule } from '../shop.module';
import {
  SHOP_CATALOGUE_RETIRED_MESSAGE,
  SHOP_RETIRED_CODE,
  SHOP_RETIRED_MESSAGE,
} from '../shop-retired';

/**
 * WAWU Shop, retired (R-2, task OPS-08).
 *
 * What a user can and cannot do now:
 *
 *   - a buyer cannot browse the shop, fill a cart or open a checkout: each of
 *     those routes answers 410 with a clear message in the error envelope,
 *     and writes nothing;
 *   - a buyer can still see a past shop order in their purchases
 *     (GET /shop/orders and GET /shop/orders/:orderId), with what they paid
 *     and the product picture, and never another buyer's order;
 *   - a charge opened before the shop closed still settles into a paid order,
 *     once, so nobody is charged with nothing to show for it;
 *   - search never returns a shop product, and neither do the Home payloads
 *     (the feed and the creator rail);
 *   - the deploy smoke test's route, /health, answers 200;
 *   - an admin campaign cannot send everybody to /shop any more.
 *
 * The admin catalogue writes (410) and reads are covered on the wire by the
 * protected route suite (MONEY-01), which logs real admins in.
 */

const BUYER_EMAIL = 'user@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';

const MOCK_WAWU_ID_PORT = 46000 + (process.pid % 3000);
const MOCK_WAWU_ID_URL = `http://127.0.0.1:${MOCK_WAWU_ID_PORT}`;
const TAG = `shop-retired-${process.pid}`;

let mockWawuId: ChildProcessWithoutNullStreams;
let app: INestApplication;
let prisma: PrismaService;
let flutterwave: FlutterwaveClient;
let buyerToken: string;
let otherToken: string;
let liveProductId: string;
let liveProductSlug: string;
let pastOrderId: string;

const http = () => request(app.getHttpServer() as Server);

/** The `data` of a success envelope. */
function dataOf<T = Record<string, unknown>>(res: request.Response): T {
  return (res.body as { data: T }).data;
}

/** The ids in a list answer. */
function idsOf(res: request.Response): string[] {
  return dataOf<Array<{ id: string }>>(res).map((o) => o.id);
}

async function waitForMock(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** The 410 every retired route answers, in the normal error envelope. */
function expectRetired(res: request.Response): void {
  expect(res.status).toBe(410);
  expect(res.body).toEqual({
    statusCode: 410,
    message: SHOP_RETIRED_MESSAGE,
    data: null,
    reason: { code: SHOP_RETIRED_CODE, message: SHOP_RETIRED_MESSAGE },
  });
}

/** A pending order as checkout used to leave it, before the shop closed. */
async function pendingOrderFor(
  productId: string,
  quantity: number,
  priceNaira: number,
  txRef: string,
) {
  return prisma.shopOrder.create({
    data: {
      buyerWawuId: BUYER_SUB,
      status: 'pending',
      subtotalNaira: priceNaira * quantity,
      totalNaira: priceNaira * quantity,
      deliveryName: 'Bola Buyer',
      deliveryPhone: '+2348012345678',
      deliveryAddress: '12 Retired Close, Yaba',
      deliveryCity: 'Lagos',
      deliveryState: 'Lagos',
      flutterwaveTxRef: txRef,
      items: {
        create: [
          {
            productId,
            nameSnapshot: `${TAG} Rode NT-USB`,
            priceNairaSnapshot: priceNaira,
            quantity,
          },
        ],
      },
    },
  });
}

beforeAll(async () => {
  mockWawuId = spawn(
    'node',
    [path.join(__dirname, '../../../mock-wawu-id/server.js')],
    {
      env: {
        ...process.env,
        MOCK_WAWU_ID_PORT: String(MOCK_WAWU_ID_PORT),
        WAWU_ID_INTERNAL_SERVICE_KEY: resolveInternalServiceKey(),
      },
      stdio: 'pipe',
    },
  );
  await waitForMock();
  process.env.WAWU_ID_JWKS_URL = `${MOCK_WAWU_ID_URL}/.well-known/jwks.json`;
  process.env.WAWU_ID_BASE_URL = MOCK_WAWU_ID_URL;

  [buyerToken, otherToken] = await Promise.all([
    loginAs(BUYER_EMAIL),
    loginAs(OTHER_EMAIL),
  ]);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      ShopModule,
      SearchResponseModule,
      ContentPieceModule,
      CreatorDiscoveryModule,
    ],
    controllers: [AppController],
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
  flutterwave = moduleRef.get<FlutterwaveClient>(FLUTTERWAVE_CLIENT, {
    strict: false,
  });

  // The catalogue as the shop left it: a live, in-stock product. Rows are
  // kept after retirement because order lines point at them.
  const live = await prisma.product.create({
    data: {
      name: `${TAG} Rode NT-USB`,
      slug: `${TAG}-live`,
      brand: 'Rode',
      description: 'A studio microphone that plugs straight into a laptop.',
      category: 'audio_music',
      subcategory: 'Microphones',
      priceNaira: 185_000,
      stock: 5,
      images: ['https://cdn.example.com/nt-usb.jpg'],
      wawuVerified: true,
      wawuPick: true,
      status: 'live',
    },
  });
  liveProductId = live.id;
  liveProductSlug = live.slug;

  // A paid order the buyer placed before the shop closed.
  const past = await prisma.shopOrder.create({
    data: {
      buyerWawuId: BUYER_SUB,
      status: 'paid',
      subtotalNaira: 185_000,
      totalNaira: 185_000,
      deliveryName: 'Bola Buyer',
      deliveryPhone: '+2348012345678',
      deliveryAddress: '12 Retired Close, Yaba',
      deliveryCity: 'Lagos',
      deliveryState: 'Lagos',
      deliveryNote: 'Call on arrival.',
      flutterwaveTxRef: `${TAG}-past`,
      flutterwaveTxId: `${TAG}-past-tx`,
      paidAt: new Date('2026-09-01T10:00:00.000Z'),
      createdAt: new Date('2026-09-01T09:58:00.000Z'),
      // The internal note that must never reach a customer.
      refundError: 'Flutterwave refused this refund; do it by hand.',
      items: {
        create: [
          {
            productId: live.id,
            nameSnapshot: `${TAG} Rode NT-USB`,
            priceNairaSnapshot: 185_000,
            quantity: 1,
          },
        ],
      },
    },
  });
  pastOrderId = past.id;
}, 40_000);

afterAll(async () => {
  await prisma?.shopOrder.deleteMany({
    where: { flutterwaveTxRef: { startsWith: TAG } },
  });
  // Orders this suite settled through the mock adapter carry its own txRef.
  await prisma?.shopOrder.deleteMany({
    where: { items: { some: { productId: liveProductId } } },
  });
  await prisma?.cartItem.deleteMany({ where: { productId: liveProductId } });
  await prisma?.product.deleteMany({ where: { slug: { startsWith: TAG } } });
  await app?.close();
  mockWawuId?.kill();
});

describe('Shop retired: browsing answers 410', () => {
  it('a visitor opening the shop is told it has closed, and sees no product', async () => {
    const anonymous = await http().get('/api/hub/shop/products');
    expectRetired(anonymous);
    expect(anonymous.text).not.toContain(TAG);

    const signedIn = await http()
      .get('/api/hub/shop/products')
      .query({ category: 'audio_music', search: 'Rode' })
      .set('Authorization', `Bearer ${buyerToken}`);
    expectRetired(signedIn);
    expect(signedIn.text).not.toContain(TAG);
  });

  it('a shared product link answers 410, not the product', async () => {
    const res = await http().get(`/api/hub/shop/${liveProductSlug}`);
    expectRetired(res);
    expect(res.text).not.toContain(liveProductId);
  });

  it('the aisle filter answers 410', async () => {
    expectRetired(
      await http().get('/api/hub/shop/categories/audio_music/subcategories'),
    );
  });

  it('the message is plain: no em-dash, and it says past orders are not affected', () => {
    for (const message of [
      SHOP_RETIRED_MESSAGE,
      SHOP_CATALOGUE_RETIRED_MESSAGE,
    ]) {
      expect(message).not.toMatch(/\u2014/);
      expect(message).toMatch(/[Oo]rders/);
    }
    // No screen shows a past Shop order today (web gated, mobile has none),
    // so the sentence promises nothing about where one can be seen.
    expect(SHOP_RETIRED_MESSAGE).not.toMatch(/purchases/);
  });
});

describe('Shop retired: the cart and checkout answer 410 and write nothing', () => {
  /** Each cart route, as a call that is only sent when it is made. */
  const cartCalls: Array<(token?: string) => request.Test> = [
    (token) => withToken(http().get('/api/hub/shop/cart'), token),
    (token) =>
      withToken(http().post('/api/hub/shop/cart'), token).send({
        productId: liveProductId,
        quantity: 1,
      }),
    (token) =>
      withToken(
        http().patch(`/api/hub/shop/cart/${liveProductId}`),
        token,
      ).send({ quantity: 2 }),
    (token) =>
      withToken(http().delete(`/api/hub/shop/cart/${liveProductId}`), token),
  ];

  function withToken(req: request.Test, token?: string): request.Test {
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  it('still needs a token first: no token is 401, as before', async () => {
    for (const call of cartCalls) expect((await call()).status).toBe(401);
    expect((await http().post('/api/hub/shop/checkout').send({})).status).toBe(
      401,
    );
  });

  it('a signed-in buyer cannot add to, change or read a cart', async () => {
    for (const call of cartCalls) expectRetired(await call(buyerToken));
    expect(
      await prisma.cartItem.count({ where: { userWawuId: BUYER_SUB } }),
    ).toBe(0);
  });

  it('placing a new shop order is refused with a clear message, and no order or charge is opened', async () => {
    const before = await prisma.shopOrder.count({
      where: { buyerWawuId: BUYER_SUB },
    });
    const res = await http()
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        deliveryName: 'Bola Buyer',
        deliveryPhone: '+2348012345678',
        deliveryAddress: '12 Retired Close, Yaba',
        deliveryCity: 'Lagos',
        deliveryState: 'Lagos',
      });
    expectRetired(res);
    expect(res.text).not.toContain('flutterwaveConfig');
    expect(
      await prisma.shopOrder.count({ where: { buyerWawuId: BUYER_SUB } }),
    ).toBe(before);
  });
});

describe('Shop retired: past orders stay readable', () => {
  it('a buyer can still see a past shop order in their purchases', async () => {
    const res = await http()
      .get('/api/hub/shop/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    const order = dataOf<Array<{ id: string } & Record<string, unknown>>>(
      res,
    ).find((o) => o.id === pastOrderId);
    expect(order).toMatchObject({
      status: 'paid',
      totalNaira: 185_000,
      fulfilment: 'awaiting_dispatch',
      items: [
        {
          productId: liveProductId,
          name: `${TAG} Rode NT-USB`,
          priceNaira: 185_000,
          quantity: 1,
          imageUrl: 'https://cdn.example.com/nt-usb.jpg',
        },
      ],
    });
  });

  it('and can open it, without the internal refund note', async () => {
    const res = await http()
      .get(`/api/hub/shop/orders/${pastOrderId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(dataOf(res)).toMatchObject({
      id: pastOrderId,
      status: 'paid',
      deliveryNote: 'Call on arrival.',
    });
    expect(dataOf(res)).not.toHaveProperty('refundError');
    expect(res.text).not.toContain('do it by hand');
  });

  it("cannot open somebody else's order", async () => {
    await http()
      .get(`/api/hub/shop/orders/${pastOrderId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });

  it('an order that was never paid for stays out of the list', async () => {
    const pending = await pendingOrderFor(
      liveProductId,
      1,
      185_000,
      `${TAG}-never-paid`,
    );
    const res = await http()
      .get('/api/hub/shop/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(idsOf(res)).not.toContain(pending.id);
    await prisma.shopOrder.delete({ where: { id: pending.id } });
  });

  it('a charge opened before the shop closed still settles once, and then shows in purchases', async () => {
    const charge = flutterwave.initCharge({
      amount: 185_000,
      purpose: 'shop-order',
      wawuUserId: BUYER_SUB,
    });
    const pending = await pendingOrderFor(
      liveProductId,
      1,
      185_000,
      charge.txRef,
    );
    const stockBefore = (
      await prisma.product.findUniqueOrThrow({ where: { id: liveProductId } })
    ).stock;

    const verify = () =>
      http()
        .post(`/api/hub/shop/orders/${pending.id}/verify`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ transaction_id: `flw-${pending.id}`, tx_ref: charge.txRef });

    const first = await verify().expect(201);
    expect(dataOf(first)).toMatchObject({ id: pending.id, status: 'paid' });
    // The browser and the webhook can both settle it; stock moves once.
    const second = await verify().expect(201);
    expect(dataOf(second)).toMatchObject({ id: pending.id, status: 'paid' });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: liveProductId } }))
        .stock,
    ).toBe(stockBefore - 1);

    const list = await http()
      .get('/api/hub/shop/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(idsOf(list)).toContain(pending.id);
  });
});

describe('Shop retired: search and Home never show a shop product', () => {
  it('search never returns a shop product, on any tab', async () => {
    for (const tab of ['all', 'content', 'creators', 'communities']) {
      const res = await http()
        .get('/api/hub/search')
        .query({ q: 'Rode', tab })
        .set('Authorization', `Bearer ${buyerToken}`)
        .expect(200);
      expect(Object.keys(dataOf(res)).sort()).toEqual([
        'communities',
        'content',
        'creators',
      ]);
      expect(res.text).not.toContain(TAG);
      expect(res.text).not.toContain(liveProductId);
    }
    const closest = await http()
      .get('/api/hub/search/closest')
      .query({ q: 'Rode' })
      .expect(200);
    expect(closest.text).not.toContain(TAG);
    const suggestions = await http()
      .get('/api/hub/search/suggestions')
      .expect(200);
    expect(suggestions.text).not.toContain(TAG);
  });

  it('the Home feed and the creator rail carry no shop product', async () => {
    const feed = await http()
      .get('/api/hub/content')
      .query({ scope: 'feed' })
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(feed.text).not.toContain(TAG);
    expect(feed.text).not.toContain(liveProductId);

    const creators = await http().get('/api/hub/creators').expect(200);
    expect(creators.text).not.toContain(TAG);
    expect(creators.text).not.toContain(liveProductId);
  });

  it('an admin campaign can no longer send everybody to the closed shop', () => {
    expect(CAMPAIGN_DESTINATIONS.map((d) => d.href)).not.toContain('/shop');
    expect(isCampaignDestination('/shop')).toBe(false);
  });
});

describe('the deploy smoke test route', () => {
  it('GET /health answers 200 with no token, so a deploy can go green', async () => {
    const res = await http().get('/api/hub/health').expect(200);
    expect(dataOf(res)).toEqual({ ok: true, service: 'wawu-hub-api' });
  });
});
