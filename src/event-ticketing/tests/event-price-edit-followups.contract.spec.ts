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

/**
 * FIX-12: the follow-ups from EVENTS-11 (R-40, ticket price edits).
 *
 * EVENTS-11's round 5 verifier killed 9 of its 12 mutants of the tier-retire
 * logic; these pin the three that survived, and the two notes it left:
 *
 *  - R7 / R8: the organiser's `remaining` leaves a retired tier out. Its
 *    seats are not for sale (R7), and a ticket a buyer settled on it after it
 *    was retired is sold but takes no seat from the tiers on sale (R8).
 *  - R10: a PUT matches what the host sends against the tiers ON SALE only.
 *    Sending a tier identical to a retired one makes a new tier; the retired
 *    row stays retired.
 *  - O8: when tickets have sold on a retired tier and on the tier that
 *    replaced it, both named the same, the sold 409 names the tier once.
 *  - PATCH on an event its host cancelled is a 409, with the sentence PUT
 *    /events/:id/tickets already answers; on a live event both work as before.
 *
 * What a price change leaves alone is asserted along the way: a buyer who
 * paid the old price keeps the order, the amount and the tickets they paid
 * for, and the organiser's gross still counts what they paid.
 *
 * The fixtures are this suite's own event ids (`ee12f...`), swept before and
 * after. The seeded creator's tick columns are snapshotted and written back
 * (README § Test hygiene).
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** A creator account that holds a live tick, so the hosting gate lets it in. */
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
/** A buyer (`user`) account: the abandoned checkout, and the stranger. */
const BUYER_EMAIL = 'user@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000001';

const EV_RETIRED = 'ee12f000-0000-4000-8000-000000000001';
const EV_RESEND = 'ee12f000-0000-4000-8000-000000000002';
const EV_NAME = 'ee12f000-0000-4000-8000-000000000003';
const EV_CANCELLED = 'ee12f000-0000-4000-8000-000000000004';
const EV_LIVE = 'ee12f000-0000-4000-8000-000000000005';
const EVENTS = [EV_RETIRED, EV_RESEND, EV_NAME, EV_CANCELLED, EV_LIVE];

const FUTURE = new Date('2027-05-06T09:00:00.000Z');
const LIVE_TICK = {
  creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
};

/** The tier every fixture event starts with, and what the host reprices to. */
const OLD = {
  tier: 'regular' as const,
  name: 'Regular',
  priceNaira: 5000,
  quantity: 100,
};
const REPRICED = {
  tier: 'regular' as const,
  name: 'Regular',
  priceNaira: 6000,
  quantity: 100,
};
const VIP = {
  tier: 'vip' as const,
  name: 'VIP',
  priceNaira: 20000,
  quantity: 10,
};

const CANCELLED_SENTENCE = 'This event has been cancelled.';

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

interface ErrorBody {
  statusCode: number;
  message: string;
}

describe('Ticket price edits: the EVENTS-11 follow-ups (FIX-12, R-40)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let tickSnapshot: object | null = null;
  let seq = 0;

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const put = (id: string, types: unknown) =>
    http()
      .put(`/api/hub/events/${id}/tickets`)
      .set(auth(hostToken))
      .send({ types });
  const patch = (id: string) =>
    http()
      .patch(`/api/hub/events/${id}`)
      .set(auth(hostToken))
      .send({ description: 'A corrected description.' });
  const dashboard = async (id: string) =>
    (
      await http()
        .get(`/api/hub/events/${id}/dashboard`)
        .set(auth(hostToken))
        .expect(200)
    ).body as {
      data: {
        ticketsSold: number;
        remaining: number;
        grossNaira: number;
        attendees: number;
      };
    };

  async function sweep(): Promise<void> {
    // Ticket types, orders, order lines and tickets cascade from Event.
    await prisma.event.deleteMany({ where: { id: { in: EVENTS } } });
  }

  async function fixture(
    id: string,
    status: 'published' | 'pending' | 'cancelled',
    tiers: Array<typeof OLD | typeof VIP> = [OLD],
  ): Promise<void> {
    await prisma.event.create({
      data: {
        id,
        hostWawuId: HOST_SUB,
        name: `EV12F ${status} ${id.slice(-2)}`,
        description: 'A fixture for the FIX-12 contract suite.',
        hostOrg: 'EV12F Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: FUTURE,
        status,
        ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}),
        ticketTypes: { create: tiers },
      },
    });
  }

  /**
   * An order for `quantity` tickets of a tier at `priceNaira` each, as a
   * Flutterwave checkout leaves it: `pending` until it is verified. The
   * charge is the price the buyer saw when they opened it.
   */
  async function openCheckout(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
    priceNaira: number,
  ) {
    seq += 1;
    return prisma.eventOrder.create({
      data: {
        eventId,
        ticketTypeId,
        buyerWawuId: BUYER_SUB,
        quantity,
        amountNaira: priceNaira * quantity,
        commissionRate: '0.15',
        status: 'pending',
        flutterwaveTxRef: `ev12f-${Date.now()}-${seq}`,
      },
    });
  }

  /**
   * What `verify` does when the money is confirmed: the order is paid, the
   * seats are issued, the tier's `sold` goes up. Done here row by row so the
   * spec needs no payment client; the rows are the ones verify writes.
   */
  async function settle(orderId: string): Promise<void> {
    const order = await prisma.eventOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    await prisma.eventOrder.update({
      where: { id: orderId },
      data: { status: 'paid', paidAt: new Date() },
    });
    for (let n = 0; n < order.quantity; n += 1) {
      seq += 1;
      await prisma.eventTicket.create({
        data: {
          orderId,
          eventId: order.eventId,
          ticketTypeId: order.ticketTypeId,
          code: `EV12F-${Date.now()}-${seq}-${n}`,
          status: 'valid',
        },
      });
    }
    await prisma.eventTicketType.update({
      where: { id: order.ticketTypeId },
      data: { sold: { increment: order.quantity } },
    });
  }

  const tiersOf = (eventId: string) =>
    prisma.eventTicketType.findMany({
      where: { eventId },
      orderBy: [{ priceNaira: 'asc' }, { id: 'asc' }],
    });

  /**
   * The host reprices Regular while a buyer has a checkout open on it: the
   * old tier is retired (never deleted, an order points at it) and a new one
   * of the same name takes its place. Returns the ids.
   */
  async function repriceWithOpenCheckout(eventId: string) {
    const [old] = await tiersOf(eventId);
    const abandoned = await openCheckout(eventId, old.id, 3, OLD.priceNaira);
    await put(eventId, [REPRICED, VIP]).expect(200);
    const after = await tiersOf(eventId);
    const retired = after.find((t) => t.id === old.id);
    expect(retired?.retiredAt).not.toBeNull();
    const regular = after.find(
      (t) => t.retiredAt === null && t.name === 'Regular',
    );
    const vip = after.find((t) => t.retiredAt === null && t.name === 'VIP');
    expect(regular?.priceNaira).toBe(REPRICED.priceNaira);
    return { old, abandoned, regular: regular!, vip: vip! };
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
      data: LIVE_TICK,
    });
  });

  beforeEach(async () => {
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    if (tickSnapshot)
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: tickSnapshot,
      });
    await app.close();
  });

  describe('the organiser remaining, with a retired tier (EVENTS-11 O7: R7, R8)', () => {
    /**
     * Regular is repriced while 3 tickets are in an open checkout, so the old
     * Regular is retired. The checkout then settles (the buyer paid at the
     * price they saw) and 2 more tickets sell on the new Regular.
     *
     * Seats for sale: new Regular 100 + VIP 10 = 110, less the 2 sold on the
     * new Regular. The 100 seats of the retired tier are not for sale, and
     * the 3 settled on it take none of the 108.
     */
    async function scenario() {
      await fixture(EV_RETIRED, 'published');
      const ids = await repriceWithOpenCheckout(EV_RETIRED);
      await settle(ids.abandoned.id);
      const second = await openCheckout(
        EV_RETIRED,
        ids.regular.id,
        2,
        REPRICED.priceNaira,
      );
      await settle(second.id);
      return { ...ids, second };
    }

    it('R7: the seats of a retired tier are not "remaining"', async () => {
      await scenario();
      const { data } = await dashboard(EV_RETIRED);
      // 110 on sale, 2 sold on sale. With the retired 100 counted this is 208.
      expect(data.remaining).toBe(108);
    });

    it('R8: tickets settled on a retired tier are sold, and take no seat from the tiers on sale', async () => {
      await scenario();
      const { data } = await dashboard(EV_RETIRED);
      // 3 on the retired Regular and 2 on the new one are all sold ...
      expect(data.ticketsSold).toBe(5);
      expect(data.attendees).toBe(5);
      // ... but only the 2 on sale come off the 110: not 105.
      expect(data.remaining).toBe(108);
    });

    it('the buyer who paid the old price keeps what they paid, and the gross counts it', async () => {
      const { abandoned, second } = await scenario();
      const first = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: abandoned.id },
      });
      expect(first.status).toBe('paid');
      expect(first.amountNaira).toBe(3 * OLD.priceNaira);
      expect(
        await prisma.eventTicket.count({
          where: { orderId: abandoned.id, status: 'valid' },
        }),
      ).toBe(3);
      const { data } = await dashboard(EV_RETIRED);
      // 3 at the old 5,000 and 2 at the new 6,000: never re-priced, never twice.
      expect(data.grossNaira).toBe(
        3 * OLD.priceNaira + 2 * REPRICED.priceNaira,
      );
      expect(
        (
          await prisma.eventOrder.findUniqueOrThrow({
            where: { id: second.id },
          })
        ).amountNaira,
      ).toBe(2 * REPRICED.priceNaira);
    });
  });

  describe('a PUT matches the tiers on sale only (EVENTS-11 O7: R10)', () => {
    it('R10: sending a tier identical to a retired one puts a new tier on sale; the retired row stays retired', async () => {
      await fixture(EV_RESEND, 'published');
      const { old } = await repriceWithOpenCheckout(EV_RESEND);

      // The host changes their mind and sends the old Regular back.
      const res = await put(EV_RESEND, [OLD, VIP]).expect(200);
      const listed = (
        res.body as {
          data: Array<{ id: string; name: string; priceNaira: number }>;
        }
      ).data;
      expect(listed.map((t) => [t.name, t.priceNaira]).sort()).toEqual(
        [
          ['Regular', 5000],
          ['VIP', 20000],
        ].sort(),
      );
      // A new row, not the retired one brought back.
      const regular = listed.find((t) => t.name === 'Regular');
      expect(regular?.id).not.toBe(old.id);

      const rows = await tiersOf(EV_RESEND);
      const retired = rows.find((t) => t.id === old.id);
      expect(retired?.retiredAt).not.toBeNull();
      // On sale: exactly one Regular and one VIP.
      expect(
        rows
          .filter((t) => t.retiredAt === null)
          .map((t) => t.name)
          .sort(),
      ).toEqual(['Regular', 'VIP']);
    });
  });

  describe('the sold-tickets 409 names a tier once (EVENTS-11 O8)', () => {
    it('after sales on a retired Regular and on the Regular that replaced it, "Regular" is named once', async () => {
      await fixture(EV_NAME, 'published');
      const { abandoned, regular } = await repriceWithOpenCheckout(EV_NAME);
      await settle(abandoned.id);
      const second = await openCheckout(
        EV_NAME,
        regular.id,
        1,
        REPRICED.priceNaira,
      );
      await settle(second.id);

      const res = await put(EV_NAME, [REPRICED]).expect(409);
      const body = res.body as ErrorBody;
      expect(body.message).toBe(
        'Tickets have already sold for "Regular". The price and places of a ticket type cannot change once a ticket is sold.',
      );
      expect(body.message).not.toContain('—');
    });

    it('two tiers with different names are both named, in order', async () => {
      await fixture(EV_NAME, 'published', [OLD, VIP]);
      await prisma.eventTicketType.updateMany({
        where: { eventId: EV_NAME },
        data: { sold: 1 },
      });
      const res = await put(EV_NAME, [REPRICED]).expect(409);
      const message = (res.body as ErrorBody).message;
      expect(message).toMatch(
        /^Tickets have already sold for "(Regular|VIP)", "(Regular|VIP)"\. /,
      );
      expect(message).toContain('"Regular"');
      expect(message).toContain('"VIP"');
    });
  });

  describe('an event its host cancelled cannot be edited (EVENTS-11 follow-up)', () => {
    it('PATCH is a 409 with the cancelled sentence, and writes nothing', async () => {
      await fixture(EV_CANCELLED, 'cancelled');
      const before = await prisma.event.findUniqueOrThrow({
        where: { id: EV_CANCELLED },
      });

      const res = await patch(EV_CANCELLED).expect(409);
      expect((res.body as ErrorBody).message).toBe(CANCELLED_SENTENCE);

      const after = await prisma.event.findUniqueOrThrow({
        where: { id: EV_CANCELLED },
      });
      // Still cancelled, not sent back to review; the text is the old text.
      expect(after.status).toBe('cancelled');
      expect(after.description).toBe(before.description);
      expect(after.cancelledAt).toEqual(before.cancelledAt);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it('PATCH on a cancelled event is refused for every field, a recap included', async () => {
      await fixture(EV_CANCELLED, 'cancelled');
      const res = await http()
        .patch(`/api/hub/events/${EV_CANCELLED}`)
        .set(auth(hostToken))
        .send({ name: 'Renamed', recapText: 'It was great.' })
        .expect(409);
      expect((res.body as ErrorBody).message).toBe(CANCELLED_SENTENCE);
      expect(
        (await prisma.event.findUniqueOrThrow({ where: { id: EV_CANCELLED } }))
          .name,
      ).not.toBe('Renamed');
    });

    it('the price-edit route answers the same 409 in the same words, and writes nothing', async () => {
      await fixture(EV_CANCELLED, 'cancelled');
      const before = await tiersOf(EV_CANCELLED);

      const res = await put(EV_CANCELLED, [REPRICED]).expect(409);
      expect((res.body as ErrorBody).message).toBe(CANCELLED_SENTENCE);

      expect(await tiersOf(EV_CANCELLED)).toEqual(before);
      expect(
        (await prisma.event.findUniqueOrThrow({ where: { id: EV_CANCELLED } }))
          .status,
      ).toBe('cancelled');
    });

    it('a cancelled event still reads to its host, and a stranger still gets 404 for the tiers', async () => {
      await fixture(EV_CANCELLED, 'cancelled');
      await http()
        .get(`/api/hub/events/${EV_CANCELLED}`)
        .set(auth(hostToken))
        .expect(200);
      await http()
        .get(`/api/hub/events/${EV_CANCELLED}/tickets`)
        .set(auth(buyerToken))
        .expect(404);
    });

    it('on a live event both routes work as before', async () => {
      await fixture(EV_LIVE, 'published');

      const edited = await patch(EV_LIVE).expect(200);
      expect((edited.body as { data: { status: string } }).data.status).toBe(
        'pending',
      );

      await prisma.event.update({
        where: { id: EV_LIVE },
        data: { status: 'published' },
      });
      await put(EV_LIVE, [REPRICED]).expect(200);
      expect(
        (await prisma.event.findUniqueOrThrow({ where: { id: EV_LIVE } }))
          .status,
      ).toBe('pending');
    });
  });
});
