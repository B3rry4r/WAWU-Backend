// Force the test DB before anything else touches PrismaService.
process.env.DATABASE_URL = process.env.DATABASE_URL?.includes('wawu_hub_test')
  ? process.env.DATABASE_URL
  : 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
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
import { ShopModule } from '../shop.module';
import { resolveInternalServiceKey } from '../../common/tests/internal-service-key';
import { DELIVERY_NAIRA, MAX_QUANTITY_PER_LINE } from '../shop.constants';

/**
 * WAWU Commerce (contract).
 *
 * The assertions here are weighted towards the ways a storefront loses money
 * or lies to somebody, not towards the happy path:
 *
 *   - stock is claimed by a CONDITIONAL write, so the last unit sells once
 *   - the order snapshots the name and price, so editing a product afterwards
 *     does not rewrite what somebody bought
 *   - `refundError` never reaches a customer's order
 *   - the exact stock count never reaches the storefront
 *   - a draft product is a 404, not a 403
 *   - verify is idempotent, so the browser and the webhook do not both deduct
 */

const BUYER_EMAIL = 'user@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';

const MOCK_WAWU_ID_PORT = 46000 + (process.pid % 3000);
const MOCK_WAWU_ID_URL = `http://127.0.0.1:${MOCK_WAWU_ID_PORT}`;
const TAG = `shop-contract-${process.pid}`;

let mockWawuId: ChildProcessWithoutNullStreams;
let app: INestApplication;
let prisma: PrismaService;
let buyerToken: string;
let otherToken: string;
let liveProductId: string;
let liveProductSlug: string;
let draftProductSlug: string;
let scarceProductId: string;

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

/** Drive a real charge-then-verify through the mock Flutterwave adapter. */
async function payFor(orderId: string, txRef: string, token: string) {
  return request(app.getHttpServer())
    .post(`/api/hub/shop/orders/${orderId}/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({ transaction_id: `flw-${orderId}`, tx_ref: txRef });
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

  const live = await prisma.product.create({
    data: {
      name: `${TAG} Rode NT-USB`,
      slug: `${TAG}-live`,
      brand: 'Rode',
      description: 'A studio microphone that plugs straight into a laptop.',
      category: 'audio_music',
      subcategory: 'Microphones',
      priceNaira: 185_000,
      compareAtNaira: 210_000,
      stock: 12,
      images: ['https://cdn.example.com/nt-usb.jpg'],
      wawuVerified: true,
      wawuPick: true,
      status: 'live',
    },
  });
  liveProductId = live.id;
  liveProductSlug = live.slug;

  const draft = await prisma.product.create({
    data: {
      name: `${TAG} Unfinished listing`,
      slug: `${TAG}-draft`,
      description: 'Still being written in the dashboard.',
      category: 'video_film',
      subcategory: 'Cameras',
      priceNaira: 1_000_000,
      stock: 3,
      images: [],
      status: 'draft',
    },
  });
  draftProductSlug = draft.slug;

  // Exactly one on the shelf — the last-unit race.
  const scarce = await prisma.product.create({
    data: {
      name: `${TAG} Last one`,
      slug: `${TAG}-scarce`,
      description: 'There is precisely one of these left in the building.',
      category: 'lighting_studio',
      subcategory: 'Ring lights',
      priceNaira: 40_000,
      stock: 1,
      images: ['https://cdn.example.com/ring.jpg'],
      status: 'live',
    },
  });
  scarceProductId = scarce.id;
}, 40_000);

afterEach(async () => {
  await prisma?.cartItem.deleteMany({
    where: {
      userWawuId: { in: [BUYER_SUB, '00000000-0000-4000-8000-000000000002'] },
    },
  });
});

afterAll(async () => {
  const ids = [liveProductId, scarceProductId].filter(Boolean);
  await prisma?.shopOrderItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma?.shopOrder.deleteMany({ where: { buyerWawuId: BUYER_SUB } });
  await prisma?.cartItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma?.product.deleteMany({ where: { slug: { startsWith: TAG } } });
  await app?.close();
  mockWawuId?.kill();
});

describe('Shop — browsing', () => {
  it('lists live products publicly, with no exact stock count on the wire', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/shop/products')
      .query({ category: 'audio_music' })
      .expect(200);

    const item = res.body.data.find(
      (p: { id: string }) => p.id === liveProductId,
    );
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      name: `${TAG} Rode NT-USB`,
      priceNaira: 185_000,
      compareAtNaira: 210_000,
      inStock: true,
      lowStock: false,
      wawuVerified: true,
    });
    // The count itself is NOT public: it tells a competitor exactly what WAWU
    // is holding, and a shopper only needs to know whether they can buy.
    expect(item).not.toHaveProperty('stock');
    expect(item).not.toHaveProperty('status');
  });

  it('reports lowStock without reporting how low', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/hub/shop/${scarceProductId ? `${TAG}-scarce` : ''}`)
      .expect(200);
    expect(res.body.data).toMatchObject({ inStock: true, lowStock: true });
    expect(res.body.data).not.toHaveProperty('stock');
  });

  it('has no rating, because there is no review system to derive one from', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/hub/shop/${liveProductSlug}`)
      .expect(200);
    // A seeded 4.8 would be fabricated social proof on something people spend
    // real money against.
    expect(res.body.data.ratingAvg).toBeNull();
    expect(res.body.data.ratingCount).toBe(0);
  });

  it('serves the Featured Products rail: image, category label and price', async () => {
    // The approved Marketplace screen draws three cards, each an image over a
    // name, a category label and a naira price, under "Featured Products".
    // Every one of those already exists on this table (`images`,
    // `subcategory`/`category`, `priceNaira`) and the rail is the WAWU PICKS
    // shelf, so nothing was added for it. This test is what says so.
    const res = await request(app.getHttpServer())
      .get('/api/hub/shop/products')
      .query({ wawuPick: true })
      .expect(200);

    const card = (res.body.data as Record<string, unknown>[]).find(
      (p) => p.id === liveProductId,
    );
    expect(card).toEqual(
      expect.objectContaining({
        images: ['https://cdn.example.com/nt-usb.jpg'],
        category: 'audio_music',
        subcategory: 'Microphones',
        priceNaira: 185_000,
        wawuPick: true,
      }),
    );

    // The rail is a filter, not everything: the scarce fixture is not a pick.
    const ids = (res.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(scarceProductId);
  });

  it('404s a draft product rather than admitting it exists', async () => {
    await request(app.getHttpServer())
      .get(`/api/hub/shop/${draftProductSlug}`)
      .expect(404);
  });

  it('lists only the subcategories that actually have stock', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/shop/categories/audio_music/subcategories')
      .expect(200);
    expect(res.body.data).toContain('Microphones');
    // A filter offering something with nothing behind it is a dead end.
    expect(res.body.data).not.toContain('Teleprompters');
  });

  it('shops by budget as a ceiling, not a band', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/shop/products')
      .query({ maxPriceNaira: 50_000 })
      .expect(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(scarceProductId);
    expect(ids).not.toContain(liveProductId);
  });
});

describe('Shop — the cart', () => {
  it('401s every cart route without a token', async () => {
    await request(app.getHttpServer()).get('/api/hub/shop/cart').expect(401);
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .send({})
      .expect(401);
  });

  it('adds, totals server-side, and adds no delivery fee', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: liveProductId, quantity: 2 })
      .expect(201);

    expect(res.body.data).toMatchObject({
      itemCount: 2,
      subtotalNaira: 370_000,
      deliveryNaira: DELIVERY_NAIRA,
      totalNaira: 370_000 + DELIVERY_NAIRA,
    });
  });

  it('adding the same product again raises the quantity instead of making a second line', async () => {
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: liveProductId, quantity: 1 })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: liveProductId, quantity: 2 })
      .expect(201);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].quantity).toBe(3);
  });

  it('never lets the cart promise more than is on the shelf', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: scarceProductId, quantity: MAX_QUANTITY_PER_LINE })
      .expect(201);
    // One in stock, so one in the cart — not twenty.
    expect(res.body.data.items[0].quantity).toBe(1);
  });

  it('400s a quantity above the per-line ceiling', async () => {
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: liveProductId, quantity: MAX_QUANTITY_PER_LINE + 1 })
      .expect(400);
  });

  it('404s a product that is not live, so a draft cannot be added by id', async () => {
    const draft = await prisma.product.findUniqueOrThrow({
      where: { slug: draftProductSlug },
    });
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: draft.id, quantity: 1 })
      .expect(404);
  });
});

describe('Shop — checkout', () => {
  async function fillCart(productId: string, quantity: number) {
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId, quantity })
      .expect(201);
  }

  const ADDRESS = {
    deliveryName: 'Adaeze Okonkwo',
    deliveryPhone: '+2348012345678',
    deliveryAddress: '14 Water Corporation Road, Victoria Island',
    deliveryCity: 'Lagos',
    deliveryState: 'Lagos',
    deliveryNote: 'Gate is behind the pharmacy.',
  };

  it('400s an empty cart', async () => {
    await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(ADDRESS)
      .expect(400);
  });

  it('REFUSES an order with no phone number — logistics is a person, not an API', async () => {
    await fillCart(liveProductId, 1);
    const { deliveryPhone: _omitted, ...noPhone } = ADDRESS;
    await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(noPhone)
      .expect(400);
  });

  it('accepts no amount from the client — an extra field is a 400', async () => {
    await fillCart(liveProductId, 1);
    await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ ...ADDRESS, totalNaira: 1 })
      .expect(400);
  });

  it('opens a charge for the SERVER-side total and reserves nothing yet', async () => {
    await fillCart(liveProductId, 2);
    const before = await prisma.product.findUniqueOrThrow({
      where: { id: liveProductId },
      select: { stock: true },
    });

    const res = await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(ADDRESS)
      .expect(201);

    expect(res.body.data.flutterwaveConfig).toMatchObject({
      amount: 370_000 + DELIVERY_NAIRA,
      currency: 'NGN',
    });

    // Nothing is held. Reserving here would let anyone empty the shelf by
    // opening checkouts they never complete.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: liveProductId },
      select: { stock: true },
    });
    expect(after.stock).toBe(before.stock);
  });

  it('claims stock, snapshots the line, and empties the cart only once PAID', async () => {
    await fillCart(liveProductId, 2);
    const before = await prisma.product.findUniqueOrThrow({
      where: { id: liveProductId },
      select: { stock: true },
    });

    const checkout = await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(ADDRESS)
      .expect(201);

    // The cart survives an unpaid checkout — losing somebody's basket because
    // their card declined is its own bug.
    const stillThere = await request(app.getHttpServer())
      .get('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(stillThere.body.data.items).toHaveLength(1);

    const paid = await payFor(
      checkout.body.data.orderId,
      checkout.body.data.flutterwaveConfig.txRef,
      buyerToken,
    );
    expect([200, 201]).toContain(paid.status);
    expect(paid.body.data.status).toBe('paid');
    expect(paid.body.data.items[0]).toMatchObject({
      name: `${TAG} Rode NT-USB`,
      priceNaira: 185_000,
      quantity: 2,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: liveProductId },
      select: { stock: true },
    });
    expect(after.stock).toBe(before.stock - 2);

    const emptied = await request(app.getHttpServer())
      .get('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(emptied.body.data.items).toHaveLength(0);
  });

  it('is idempotent — the browser and the webhook do not both deduct stock', async () => {
    await fillCart(liveProductId, 1);
    const checkout = await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(ADDRESS)
      .expect(201);

    const first = await payFor(
      checkout.body.data.orderId,
      checkout.body.data.flutterwaveConfig.txRef,
      buyerToken,
    );
    expect([200, 201]).toContain(first.status);
    const afterFirst = await prisma.product.findUniqueOrThrow({
      where: { id: liveProductId },
      select: { stock: true },
    });

    const second = await payFor(
      checkout.body.data.orderId,
      checkout.body.data.flutterwaveConfig.txRef,
      buyerToken,
    );
    expect([200, 201]).toContain(second.status);
    const afterSecond = await prisma.product.findUniqueOrThrow({
      where: { id: liveProductId },
      select: { stock: true },
    });
    expect(afterSecond.stock).toBe(afterFirst.stock);
  });

  it('sells the LAST unit exactly once', async () => {
    // Two buyers, one item on the shelf, both reaching checkout before either
    // pays — which is the ordinary case for anything worth stocking.
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: scarceProductId, quantity: 1 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/hub/shop/cart')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ productId: scarceProductId, quantity: 1 })
      .expect(201);

    const a = await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(ADDRESS)
      .expect(201);
    const b = await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(ADDRESS)
      .expect(201);

    const first = await payFor(
      a.body.data.orderId,
      a.body.data.flutterwaveConfig.txRef,
      buyerToken,
    );
    expect([200, 201]).toContain(first.status);

    // The second one is REFUSED rather than seated. A read-then-write would
    // have sold one ring light to two people.
    const second = await payFor(
      b.body.data.orderId,
      b.body.data.flutterwaveConfig.txRef,
      otherToken,
    );
    expect(second.status).toBe(409);

    const left = await prisma.product.findUniqueOrThrow({
      where: { id: scarceProductId },
      select: { stock: true },
    });
    expect(left.stock).toBe(0);

    await prisma.product.update({
      where: { id: scarceProductId },
      data: { stock: 1 },
    });
    await prisma.shopOrder.deleteMany({
      where: { id: { in: [a.body.data.orderId, b.body.data.orderId] } },
    });
  });

  it('editing a product afterwards does not rewrite what somebody bought', async () => {
    await fillCart(liveProductId, 1);
    const checkout = await request(app.getHttpServer())
      .post('/api/hub/shop/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(ADDRESS)
      .expect(201);
    await payFor(
      checkout.body.data.orderId,
      checkout.body.data.flutterwaveConfig.txRef,
      buyerToken,
    );

    await prisma.product.update({
      where: { id: liveProductId },
      data: { name: 'Renamed after the sale', priceNaira: 999_999 },
    });

    const order = await request(app.getHttpServer())
      .get(`/api/hub/shop/orders/${checkout.body.data.orderId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);

    expect(order.body.data.items[0].name).toBe(`${TAG} Rode NT-USB`);
    expect(order.body.data.items[0].priceNaira).toBe(185_000);

    await prisma.product.update({
      where: { id: liveProductId },
      data: { name: `${TAG} Rode NT-USB`, priceNaira: 185_000 },
    });
  });
});

describe('Shop — orders', () => {
  it("403s somebody else's order, and never leaks refundError", async () => {
    const order = await prisma.shopOrder.create({
      data: {
        buyerWawuId: BUYER_SUB,
        status: 'paid',
        subtotalNaira: 1000,
        totalNaira: 1000,
        deliveryName: 'A',
        deliveryPhone: '+2348000000000',
        deliveryAddress: 'Somewhere',
        deliveryCity: 'Lagos',
        deliveryState: 'Lagos',
        flutterwaveTxRef: `${TAG}-leak-check`,
        paidAt: new Date(),
        // The internal note that must never reach a customer.
        refundError: 'Flutterwave refused this refund; do it by hand.',
      },
    });

    await request(app.getHttpServer())
      .get(`/api/hub/shop/orders/${order.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    const mine = await request(app.getHttpServer())
      .get(`/api/hub/shop/orders/${order.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);

    expect(mine.body.data).not.toHaveProperty('refundError');
    expect(JSON.stringify(mine.body)).not.toContain('do it by hand');

    await prisma.shopOrder.delete({ where: { id: order.id } });
  });

  it('keeps unpaid orders out of order history', async () => {
    const pending = await prisma.shopOrder.create({
      data: {
        buyerWawuId: BUYER_SUB,
        status: 'pending',
        subtotalNaira: 500,
        totalNaira: 500,
        deliveryName: 'A',
        deliveryPhone: '+2348000000000',
        deliveryAddress: 'Somewhere',
        deliveryCity: 'Lagos',
        deliveryState: 'Lagos',
        flutterwaveTxRef: `${TAG}-pending`,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/api/hub/shop/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);

    // A pending order was never paid for. Listing it reads as "you bought
    // this", which is false.
    expect(res.body.data.map((o: { id: string }) => o.id)).not.toContain(
      pending.id,
    );
    await prisma.shopOrder.delete({ where: { id: pending.id } });
  });
});
