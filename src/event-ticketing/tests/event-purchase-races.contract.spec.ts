import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../../event/event.module';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminEventsModule } from '../../admin/events/admin-events.module';
import { EventTicketingModule } from '../event-ticketing.module';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from '../../direct-message/flutterwave-client.interface';

/**
 * EVENTS-11 D2: a host's PUT /events/:id/tickets racing a ticket purchase.
 *
 * A purchase settles in `issueOrder`: it increments the tier's `sold` (a
 * lock on the tier row), then inserts the order and the tickets, whose
 * foreign keys take FOR KEY SHARE on the event row. Round 3's PUT held FOR
 * UPDATE on the event row and then waited for the tier row: a deadlock, a
 * 500 for one of the two. Each round here sends both at once and checks
 * that nobody gets a 500 and the end state is one of the right ones:
 *
 *  - the purchase landed first: it is sold, and the PUT answers 409 (sold)
 *    with nothing written;
 *  - the PUT landed first: the tiers are replaced, the event is back in
 *    review, and the purchase is refused cleanly (404 or 409), no order.
 *
 * The paid path settles through the same `issueOrder` once the payment is
 * confirmed (POST /events/orders/:orderId/verify). The payment client is
 * replaced at its seam (FLUTTERWAVE_CLIENT) by a stand-in that confirms
 * every charge, so no payment provider is called.
 *
 * Round 5 (D3, O5, O6): a tier an order points at is RETIRED, not deleted,
 * when a PUT drops or changes it. So an abandoned checkout no longer blocks
 * the host, a checkout opening while a PUT replaces its tier is never a
 * foreign-key 500, a retired tier cannot be bought ("This ticket has
 * changed."), and a pending order on it still settles.
 *
 * Fixture ids `ee11b0..`; the host's tick columns are snapshotted and
 * written back.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
const BUYER_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER_BUYER_EMAIL = 'user@test.wawu.dev';
const ADMIN_ID = 'ad11b000-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'events11-purchase@admin.test.wawu.dev';
const ADMIN_PASSWORD = 'events-eleven-purchase-password';
const TIER_CHANGED = 'This ticket has changed. Please choose again.';
const CHECKOUT_ROUNDS = 30;
const EV = 'ee11b000-0000-4000-8000-000000000001';
const FREE_ROUNDS = 40;
const PAID_ROUNDS = 20;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Confirms every charge for exactly what was asked. Never leaves the process. */
const payments: FlutterwaveClient = {
  initCharge: ({ amount }) => ({
    txRef: `ev11-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    amount,
    currency: 'NGN',
    publicKey: 'FLWPUBK_TEST-stand-in',
  }),
  verifyCharge: ({ transactionId, txRef }) =>
    Promise.resolve({
      status: 'successful',
      amount: Number(transactionId.split('-')[1]),
      currency: 'NGN',
      txRef,
      transactionId,
    }),
  refundCharge: () =>
    Promise.resolve({
      status: 'settled',
      reference: null,
      message: null,
      permanent: false,
    }),
};

describe('PUT /events/:id/tickets and ticket purchases (EVENTS-11 D2, D3, O5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let otherBuyerToken: string;
  let adminToken: string;
  let tickSnapshot: Record<string, Date | null> | null = null;
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  type Tier = {
    tier: 'free' | 'regular' | 'vip';
    name: string;
    priceNaira: number;
  };
  const FREE: Tier = { tier: 'free', name: 'Entry', priceNaira: 0 };
  const PAID: Tier = { tier: 'regular', name: 'Regular', priceNaira: 5000 };

  async function sweep(): Promise<void> {
    await prisma.adminEventReview.deleteMany({ where: { eventId: EV } });
    // Tickets, orders and tiers cascade from Event.
    await prisma.event.deleteMany({ where: { id: EV } });
  }

  /** A fresh published event with one tier of 1000; returns the tier's id. */
  async function onSale(tier: Tier): Promise<string> {
    await sweep();
    await prisma.event.create({
      data: {
        id: EV,
        hostWawuId: HOST_SUB,
        name: 'EV11 purchase race',
        description: 'A fixture for the EVENTS-11 purchase race suite.',
        hostOrg: 'EV11 Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: new Date('2027-05-06T09:00:00.000Z'),
        status: 'published',
        ticketTypes: { create: [{ ...tier, quantity: 1000 }] },
      },
    });
    const row = await prisma.eventTicketType.findFirstOrThrow({
      where: { eventId: EV },
    });
    return row.id;
  }

  function put(types: Array<Tier & { quantity: number }>) {
    return http()
      .put(`/api/hub/events/${EV}/tickets`)
      .set(auth(hostToken))
      .send({ types });
  }

  function order(token: string, ticketTypeId: string) {
    return http()
      .post(`/api/hub/events/${EV}/orders`)
      .set(auth(token))
      .send({ ticketTypeId, quantity: 1 });
  }

  function verify(orderId: string, txRef: string, amount = 5000, n = 0) {
    return http()
      .post(`/api/hub/events/orders/${orderId}/verify`)
      .set(auth(buyerToken))
      .send({ transaction_id: `flwtx-${amount}-${n}`, tx_ref: txRef });
  }

  /** Opens a paid checkout and leaves it open (nothing ever verifies it). */
  async function openCheckout(ticketTypeId: string) {
    const res = await order(buyerToken, ticketTypeId).expect(201);
    return (
      res.body as {
        data: { orderId: string; flutterwaveConfig: { txRef: string } };
      }
    ).data;
  }

  async function endState() {
    const [event, tiers, orders, tickets] = await Promise.all([
      prisma.event.findUniqueOrThrow({ where: { id: EV } }),
      prisma.eventTicketType.findMany({
        where: { eventId: EV },
        orderBy: { priceNaira: 'asc' },
      }),
      prisma.eventOrder.findMany({ where: { eventId: EV } }),
      prisma.eventTicket.count({ where: { eventId: EV } }),
    ]);
    return {
      event,
      tiers,
      onSale: tiers.filter((t) => !t.retiredAt),
      retired: tiers.filter((t) => !!t.retiredAt),
      orders,
      tickets,
    };
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = 'events-eleven-buy-access-0123456789abcdef';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'events-eleven-buy-refresh-0123456789abcdef';
    [hostToken, buyerToken, otherBuyerToken] = await Promise.all([
      login(HOST_EMAIL),
      login(BUYER_EMAIL),
      login(OTHER_BUYER_EMAIL),
    ]);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminEventsModule,
        WawuAuthModule,
        EventModule,
        EventTicketingModule,
      ],
    })
      .overrideProvider(FLUTTERWAVE_CLIENT)
      .useValue(payments)
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
    // One listening server for both requests of a race (see the D1 suite).
    await app.listen(Number(process.env.RACE_SPEC_PORT ?? 5354));
    prisma = moduleRef.get(PrismaService);

    const argon2 = await import('argon2');
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.adminUser.create({
      data: {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        name: 'EV11 Purchase',
        role: 'superadmin',
        passwordHash: await argon2.hash(ADMIN_PASSWORD),
      },
    });
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    adminToken = (res.body as { data: { accessToken: string } }).data
      .accessToken;

    tickSnapshot = await prisma.userProfile.findUnique({
      where: { wawuUserId: HOST_SUB },
      select: {
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
        professionalVerifiedAt: true,
        professionalVerifiedUntil: true,
      },
    });
    await prisma.userProfile.update({
      where: { wawuUserId: HOST_SUB },
      data: {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await sweep();
    if (tickSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: tickSnapshot,
      });
    }
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(`D2: a free purchase and a PUT on the same tier: no 500, and one of the right endings (${FREE_ROUNDS} rounds)`, async () => {
    const wrong: string[] = [];
    const endings = new Map<string, number>();
    for (let round = 0; round < FREE_ROUNDS; round++) {
      const tierId = await onSale(FREE);
      const [putRes, buyRes] = await Promise.all([
        put([{ ...FREE, quantity: 1100 + round }]),
        order(buyerToken, tierId),
      ]);
      const end = await endState();
      const key = `put ${putRes.status} buy ${buyRes.status} final ${end.event.status}`;
      endings.set(key, (endings.get(key) ?? 0) + 1);

      // The purchase landed first: sold, and the PUT is the sold 409.
      const purchaseFirst =
        buyRes.status === 201 &&
        putRes.status === 409 &&
        end.event.status === 'published' &&
        end.tiers.length === 1 &&
        end.tiers[0].id === tierId &&
        end.tiers[0].sold === 1 &&
        end.orders.length === 1 &&
        end.tickets === 1;
      // The PUT landed first: the old tier (no order) is gone, the new one
      // is on sale in review, and the purchase was refused, never with the
      // misleading "sold out" (O6).
      const putFirst =
        putRes.status === 200 &&
        [404, 409].includes(buyRes.status) &&
        (buyRes.body as { message?: string }).message !==
          'This ticket is sold out.' &&
        end.event.status === 'pending' &&
        end.tiers.length === 1 &&
        end.tiers[0].quantity === 1100 + round &&
        end.tiers[0].sold === 0 &&
        end.orders.length === 0 &&
        end.tickets === 0;
      if (!purchaseFirst && !putFirst) wrong.push(`round ${round}: ${key}`);
    }
    expect({ wrong, endings: Object.fromEntries(endings) }).toEqual({
      wrong: [],
      endings: expect.any(Object) as unknown,
    });
  }, 180_000);

  it(`D2: a paid order settling (verify, issueOrder) while a PUT reprices its tier: no 500, the buyer is seated on the tier they paid for (${PAID_ROUNDS} rounds)`, async () => {
    const wrong: string[] = [];
    for (let round = 0; round < PAID_ROUNDS; round++) {
      const tierId = await onSale(PAID);
      const { orderId, txRef } = await openCheckout(tierId).then((d) => ({
        orderId: d.orderId,
        txRef: d.flutterwaveConfig.txRef,
      }));
      const [putRes, verifyRes] = await Promise.all([
        put([{ ...PAID, priceNaira: 6000, quantity: 1000 }]),
        verify(orderId, txRef, 5000, round),
      ]);
      const end = await endState();
      const paidOrder = end.orders.find((o) => o.id === orderId);
      const old = end.tiers.find((t) => t.id === tierId);
      const common =
        verifyRes.status === 201 &&
        paidOrder?.status === 'paid' &&
        paidOrder.ticketTypeId === tierId &&
        old?.sold === 1 &&
        end.tickets === 1;
      // Settled first: sold, so the PUT is the sold 409, nothing changed.
      const settledFirst =
        common &&
        putRes.status === 409 &&
        end.event.status === 'published' &&
        end.tiers.length === 1 &&
        !old.retiredAt;
      // Repriced first: the old tier (a pending order on it) is retired,
      // the new one is on sale with none of its seats taken, and the order
      // still settles on the retired tier at ₦5,000.
      const repricedFirst =
        common &&
        putRes.status === 200 &&
        end.event.status === 'pending' &&
        !!old.retiredAt &&
        end.onSale.length === 1 &&
        end.onSale[0].priceNaira === 6000 &&
        end.onSale[0].sold === 0;
      if (!settledFirst && !repricedFirst) {
        wrong.push(
          `round ${round}: put ${putRes.status} verify ${verifyRes.status} final ${end.event.status}, tiers ${end.tiers.length}, old sold ${old?.sold} retired ${Boolean(old?.retiredAt)}, order ${paidOrder?.status}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  }, 180_000);

  it(`O5: a paid checkout opening while a PUT replaces its tier: no 500, and one of the right endings (${CHECKOUT_ROUNDS} rounds)`, async () => {
    const wrong: string[] = [];
    const endings = new Map<string, number>();
    for (let round = 0; round < CHECKOUT_ROUNDS; round++) {
      const tierId = await onSale(PAID);
      const [putRes, buyRes] = await Promise.all([
        put([{ ...PAID, priceNaira: 6000 + round, quantity: 1000 }]),
        order(buyerToken, tierId),
      ]);
      const end = await endState();
      const key = `put ${putRes.status} checkout ${buyRes.status} final ${end.event.status}`;
      endings.set(key, (endings.get(key) ?? 0) + 1);
      const fresh =
        end.onSale.length === 1 && end.onSale[0].priceNaira === 6000 + round;
      // The checkout opened first: its tier is retired, not deleted.
      const checkoutFirst =
        buyRes.status === 201 &&
        putRes.status === 200 &&
        fresh &&
        end.retired.length === 1 &&
        end.retired[0].id === tierId &&
        end.orders.length === 1 &&
        end.orders[0].status === 'pending';
      // The PUT replaced it first: the checkout is refused cleanly.
      const putFirst =
        putRes.status === 200 &&
        [404, 409].includes(buyRes.status) &&
        fresh &&
        end.retired.length === 0 &&
        end.orders.length === 0;
      if (!checkoutFirst && !putFirst) wrong.push(`round ${round}: ${key}`);
    }
    expect({ wrong, endings: Object.fromEntries(endings) }).toEqual({
      wrong: [],
      endings: expect.any(Object) as unknown,
    });
  }, 180_000);

  it('D3: an abandoned checkout no longer blocks the host: PUT 200, the old tier retired, the public sees only the new tiers, and the old checkout still settles', async () => {
    const tierId = await onSale(PAID);
    const abandoned = await openCheckout(tierId);

    const res = await put([
      { ...PAID, priceNaira: 6000, quantity: 1000 },
      { tier: 'vip', name: 'VIP', priceNaira: 20000, quantity: 10 },
    ]).expect(200);
    const listed = (res.body as { data: { id: string; priceNaira: number }[] })
      .data;
    expect(listed.map((t) => t.priceNaira)).toEqual([6000, 20000]);
    expect(listed.map((t) => t.id)).not.toContain(tierId);

    let end = await endState();
    expect(end.event.status).toBe('pending');
    expect(end.retired.map((t) => t.id)).toEqual([tierId]);

    // The reviewer sees only the tiers on sale; so does the public once
    // approved, on the tiers route and in the event's "from" price.
    const detail = await http()
      .get(`/api/hub/admin/events/${EV}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      (
        detail.body as { data: { ticketTypes: { priceNaira: number }[] } }
      ).data.ticketTypes.map((t) => t.priceNaira),
    ).toEqual([6000, 20000]);
    await http()
      .post(`/api/hub/admin/events/${EV}/approve`)
      .set(auth(adminToken))
      .expect(200);
    const pub = await http()
      .get(`/api/hub/events/${EV}/tickets`)
      .set(auth(otherBuyerToken))
      .expect(200);
    expect(
      (pub.body as { data: { id: string; priceNaira: number }[] }).data.map(
        (t) => t.priceNaira,
      ),
    ).toEqual([6000, 20000]);
    const view = await http()
      .get(`/api/hub/events/${EV}`)
      .set(auth(otherBuyerToken))
      .expect(200);
    expect(
      (view.body as { data: { priceFromNaira: number } }).data.priceFromNaira,
    ).toBe(6000);

    // The abandoned checkout comes back after all, and settles at the price
    // its buyer saw, on the retired tier; the new tiers lose no seat.
    await verify(abandoned.orderId, abandoned.flutterwaveConfig.txRef).expect(
      201,
    );
    end = await endState();
    expect(end.orders[0].status).toBe('paid');
    expect(end.orders[0].amountNaira).toBe(5000);
    expect(end.tickets).toBe(1);
    expect(end.retired[0].sold).toBe(1);
    expect(end.onSale.map((t) => t.sold)).toEqual([0, 0]);
    const after = await http()
      .get(`/api/hub/events/${EV}/tickets`)
      .set(auth(otherBuyerToken))
      .expect(200);
    expect(
      (after.body as { data: { remaining: number }[] }).data.map(
        (t) => t.remaining,
      ),
    ).toEqual([1000, 10]);
  });

  it('D3, as the verifier found it: the host keeps the tier with an open checkout and adds another; the kept tier is untouched', async () => {
    const tierId = await onSale(PAID);
    await openCheckout(tierId);
    await put([
      { ...PAID, quantity: 1000 },
      { tier: 'vip', name: 'VIP', priceNaira: 20000, quantity: 10 },
    ]).expect(200);
    const end = await endState();
    expect(end.retired).toEqual([]);
    expect(end.onSale.map((t) => t.id)).toContain(tierId);
    expect(end.onSale).toHaveLength(2);
  });

  it('a retired tier cannot be bought: "This ticket has changed. Please choose again." (409), before and after the event is approved again', async () => {
    const tierId = await onSale(PAID);
    await openCheckout(tierId);
    await put([{ ...PAID, priceNaira: 6000, quantity: 1000 }]).expect(200);
    const before = await order(otherBuyerToken, tierId).expect(409);
    expect((before.body as { message: string }).message).toBe(TIER_CHANGED);
    await http()
      .post(`/api/hub/admin/events/${EV}/approve`)
      .set(auth(adminToken))
      .expect(200);
    const after = await order(otherBuyerToken, tierId).expect(409);
    expect((after.body as { message: string }).message).toBe(TIER_CHANGED);
    const end = await endState();
    expect(end.orders).toHaveLength(1);
  });

  it('the sold rule stays: once a paid order is settled on a tier, a change is the sold 409 and writes nothing', async () => {
    const tierId = await onSale(PAID);
    const paid = await openCheckout(tierId);
    await verify(paid.orderId, paid.flutterwaveConfig.txRef).expect(201);
    const before = await endState();
    const res = await put([{ ...PAID, priceNaira: 6000, quantity: 1000 }]);
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'Tickets have already sold for "Regular". Add a new tier instead of editing one people have bought.',
    );
    expect(await endState()).toEqual(before);
  });
});
