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
 * Fixture ids `ee11b0..`; the host's tick columns are snapshotted and
 * written back.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
const BUYER_EMAIL = 'creator-basic@test.wawu.dev';
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

describe('PUT /events/:id/tickets racing a ticket purchase (EVENTS-11 D2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let tickSnapshot: Record<string, Date | null> | null = null;

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function sweep(): Promise<void> {
    // Tickets and orders cascade from Event; tickets before tiers.
    await prisma.event.deleteMany({ where: { id: EV } });
  }

  /** A fresh published event with one tier; returns the tier's id. */
  async function onSale(tier: {
    tier: 'free' | 'regular';
    name: string;
    priceNaira: number;
  }): Promise<string> {
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

  function put(
    tier: { tier: 'free' | 'regular'; name: string; priceNaira: number },
    quantity: number,
  ) {
    return http()
      .put(`/api/hub/events/${EV}/tickets`)
      .set(auth(hostToken))
      .send({ types: [{ ...tier, quantity }] });
  }

  async function endState() {
    const [event, tiers, orders, tickets] = await Promise.all([
      prisma.event.findUniqueOrThrow({ where: { id: EV } }),
      prisma.eventTicketType.findMany({ where: { eventId: EV } }),
      prisma.eventOrder.findMany({ where: { eventId: EV } }),
      prisma.eventTicket.count({ where: { eventId: EV } }),
    ]);
    return { event, tiers, orders, tickets };
  }

  beforeAll(async () => {
    [hostToken, buyerToken] = await Promise.all([
      login(HOST_EMAIL),
      login(BUYER_EMAIL),
    ]);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
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
    await app.close();
  });

  it(`a free purchase and a PUT on the same tier: no 500, and one of the right endings (${FREE_ROUNDS} rounds)`, async () => {
    const wrong: string[] = [];
    const endings = new Map<string, number>();
    const free = { tier: 'free' as const, name: 'Entry', priceNaira: 0 };
    for (let round = 0; round < FREE_ROUNDS; round++) {
      const tierId = await onSale(free);
      const [putRes, buyRes] = await Promise.all([
        put(free, 1100 + round),
        http()
          .post(`/api/hub/events/${EV}/orders`)
          .set(auth(buyerToken))
          .send({ ticketTypeId: tierId, quantity: 1 }),
      ]);
      const end = await endState();
      const key = `put ${putRes.status} buy ${buyRes.status} final ${end.event.status}`;
      endings.set(key, (endings.get(key) ?? 0) + 1);

      const purchaseFirst =
        buyRes.status === 201 &&
        putRes.status === 409 &&
        end.event.status === 'published' &&
        end.tiers.length === 1 &&
        end.tiers[0].id === tierId &&
        end.tiers[0].sold === 1 &&
        end.orders.length === 1 &&
        end.tickets === 1;
      const putFirst =
        putRes.status === 200 &&
        [404, 409].includes(buyRes.status) &&
        end.event.status === 'pending' &&
        end.tiers.length === 1 &&
        end.tiers[0].quantity === 1100 + round &&
        end.tiers[0].sold === 0 &&
        end.orders.length === 0 &&
        end.tickets === 0;
      if (!purchaseFirst && !putFirst) wrong.push(`round ${round}: ${key}`);
    }
    // Which ending a round gets depends on timing. A 500 is never one of
    // the right ones, so it lands in `wrong` with the rest.
    expect({ wrong, endings: Object.fromEntries(endings) }).toEqual({
      wrong: [],
      endings: expect.any(Object) as unknown,
    });
  }, 180_000);

  it(`a paid purchase settling (verify, issueOrder) while a PUT lands: no 500, the buyer gets the ticket they paid for (${PAID_ROUNDS} rounds)`, async () => {
    const wrong: string[] = [];
    const paid = {
      tier: 'regular' as const,
      name: 'Regular',
      priceNaira: 5000,
    };
    for (let round = 0; round < PAID_ROUNDS; round++) {
      const tierId = await onSale(paid);
      const opened = await http()
        .post(`/api/hub/events/${EV}/orders`)
        .set(auth(buyerToken))
        .send({ ticketTypeId: tierId, quantity: 1 })
        .expect(201);
      const { orderId, flutterwaveConfig } = (
        opened.body as {
          data: { orderId: string; flutterwaveConfig: { txRef: string } };
        }
      ).data;

      const [putRes, verifyRes] = await Promise.all([
        put(paid, 1100 + round),
        http()
          .post(`/api/hub/events/orders/${orderId}/verify`)
          .set(auth(buyerToken))
          .send({
            transaction_id: `flwtx-5000-${round}`,
            tx_ref: flutterwaveConfig.txRef,
          }),
      ]);
      const end = await endState();
      // The order existed before the PUT, so its tier can never be replaced
      // under it: the PUT is refused (a payment in progress, or sold), and
      // the buyer is seated on the tier they paid for.
      const ok =
        verifyRes.status === 201 &&
        putRes.status === 409 &&
        end.event.status === 'published' &&
        end.tiers.length === 1 &&
        end.tiers[0].id === tierId &&
        end.tiers[0].sold === 1 &&
        end.orders.length === 1 &&
        end.orders[0].status === 'paid' &&
        end.tickets === 1;
      if (!ok) {
        wrong.push(
          `round ${round}: put ${putRes.status} verify ${verifyRes.status} final ${end.event.status}, tiers ${end.tiers.length}, sold ${end.tiers[0]?.sold}, order ${end.orders[0]?.status}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  }, 180_000);

  it('a PUT while a payment is open (not yet confirmed) is a 409 that names the tier, and writes nothing', async () => {
    const paid = {
      tier: 'regular' as const,
      name: 'Regular',
      priceNaira: 5000,
    };
    const tierId = await onSale(paid);
    await http()
      .post(`/api/hub/events/${EV}/orders`)
      .set(auth(buyerToken))
      .send({ ticketTypeId: tierId, quantity: 1 })
      .expect(201);
    const before = await endState();
    const res = await put(paid, 2000).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'A buyer is paying for "Regular" right now, so the tiers cannot be replaced yet. Add a new tier instead, or try again once that payment has finished.',
    );
    // The same tiers sent again are still "no change", payment or not.
    await put(paid, 1000).expect(200);
    expect(await endState()).toEqual(before);
  });
});
