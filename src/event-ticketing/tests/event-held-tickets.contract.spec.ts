import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../../event/event.module';
import { EventTicketingModule } from '../event-ticketing.module';

/**
 * EVENTS-03: my tickets (E6), one ticket and its QR code (E7), checked in (E12).
 *
 * What a person can do here, each proved below:
 *  - see their tickets under Upcoming or Past, one row per order and tier,
 *    with the count ("2 x Free"), nearest first, in pages;
 *  - never see someone else's, an unpaid order's, or learn that a ticket exists
 *    when it is not theirs (404 either way);
 *  - open one ticket and get the exact code the door check-in accepts, their
 *    own name, the event's zone and venue, and the tickets next to it;
 *  - once the door has scanned it, read "checked in" with the same time the
 *    door gave;
 *  - the protected `GET /events/tickets/mine` keeps its answer.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
/** The holder. The mock's name for this account is "Chidi Umeh". */
const BUYER_EMAIL = 'creator-basic@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000002';
const OTHER_EMAIL = 'creator-pro@test.wawu.dev';

const EV_SOON = 'e3000000-0000-4000-8000-000000000001';
const EV_LATER = 'e3000000-0000-4000-8000-000000000002';
const EV_PAST = 'e3000000-0000-4000-8000-000000000003';
const EV_CALLED_OFF = 'e3000000-0000-4000-8000-000000000004';
const EV_UNPAID = 'e3000000-0000-4000-8000-000000000005';
const OUR_EVENTS = [EV_SOON, EV_LATER, EV_PAST, EV_CALLED_OFF, EV_UNPAID];
const UNKNOWN = 'e3000000-0000-4000-8000-0000000000ff';

const day = 24 * 60 * 60 * 1000;
const SOON = new Date(Date.now() + 5 * day);
const LATER = new Date(Date.now() + 40 * day);
const PAST = new Date(Date.now() - 20 * day);

function data<T>(res: { body: unknown }): T {
  return (res.body as { data: T }).data;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(`mock-wawu-id login ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

type Group = {
  orderId: string;
  tierName: string;
  quantity: number;
  event: { id: string; timezone: string | null; venueName: string | null };
  tickets: { id: string; status: string; checkedInAt: string | null }[];
};
type Page = {
  data: Group[];
  pagination: { total: number; currentPage: number; nextPage: number | null };
};

describe('My tickets (EVENTS-03)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let otherToken: string;
  const tier: Record<string, string> = {};
  const orders: Record<string, string> = {};

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const held = (t: string, qs = '') =>
    http().get(`/api/hub/events/tickets/held${qs}`).set(auth(t));
  const one = (t: string, id: string) =>
    http().get(`/api/hub/events/tickets/held/${id}`).set(auth(t));

  async function sweep() {
    await prisma.event.deleteMany({ where: { id: { in: OUR_EVENTS } } });
  }

  async function order(
    key: string,
    eventId: string,
    quantity: number,
    status: 'paid' | 'pending' = 'paid',
    buyer = BUYER_SUB,
  ) {
    const o = await prisma.eventOrder.create({
      data: {
        eventId,
        ticketTypeId: tier[eventId],
        buyerWawuId: buyer,
        quantity,
        amountNaira: 0,
        commissionRate: 0,
        status,
        flutterwaveTxRef: `e3-${key}-${Date.now()}`,
      },
    });
    orders[key] = o.id;
    for (let i = 0; i < quantity; i++) {
      await prisma.eventTicket.create({
        data: {
          orderId: o.id,
          eventId,
          ticketTypeId: tier[eventId],
          code: `E3${key.toUpperCase().slice(0, 2)}-${String(i)}${Math.random().toString(36).slice(2, 5).toUpperCase()}-ABCD-EFGH`,
        },
      });
    }
    return o.id;
  }

  beforeAll(async () => {
    [hostToken, buyerToken, otherToken] = await Promise.all([
      login(HOST_EMAIL),
      login(BUYER_EMAIL),
      login(OTHER_EMAIL),
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

    await sweep();
    const base = {
      hostWawuId: HOST_SUB,
      description: 'A fixture event for the EVENTS-03 suite.',
      hostOrg: 'Ticket Fixtures Ltd',
      format: 'in_person' as const,
      type: 'summit' as const,
      location: 'Lagos',
      status: 'published' as const,
    };
    await prisma.event.createMany({
      data: [
        {
          ...base,
          id: EV_SOON,
          name: 'Soon Summit',
          startsAt: SOON,
          venueName: 'Eko Hall',
          timezone: 'America/New_York',
          timeLabel: '10:00 EDT',
        },
        { ...base, id: EV_LATER, name: 'Later Summit', startsAt: LATER },
        { ...base, id: EV_PAST, name: 'Past Summit', startsAt: PAST },
        {
          ...base,
          id: EV_CALLED_OFF,
          name: 'Called Off Summit',
          startsAt: LATER,
          status: 'cancelled',
          cancelledAt: new Date(),
        },
        { ...base, id: EV_UNPAID, name: 'Unpaid Summit', startsAt: LATER },
      ],
    });
    for (const id of OUR_EVENTS) {
      const t = await prisma.eventTicketType.create({
        data: {
          eventId: id,
          tier: 'free',
          name: id === EV_LATER ? 'Free later' : 'Free',
          priceNaira: 0,
          quantity: 500,
        },
      });
      tier[id] = t.id;
    }
    // One order bought through the real route; the rest are written as rows.
    const bought = await http()
      .post(`/api/hub/events/${EV_SOON}/orders`)
      .set(auth(buyerToken))
      .send({ ticketTypeId: tier[EV_SOON], quantity: 2 })
      .expect(201);
    orders.soonA = data<{ orderId: string }>(bought).orderId;
    await order('soonB', EV_SOON, 1);
    await order('later', EV_LATER, 1);
    await order('past', EV_PAST, 1);
    await order('off', EV_CALLED_OFF, 1);
    await order('unpaid', EV_UNPAID, 3, 'pending');
    await order(
      'theirs',
      EV_SOON,
      1,
      'paid',
      '00000000-0000-4000-8000-000000000003',
    );
  }, 60_000);

  afterAll(async () => {
    await sweep();
    await app.close();
  });

  it('no token is refused on both routes', async () => {
    await http().get('/api/hub/events/tickets/held').expect(401);
    await http().get(`/api/hub/events/tickets/held/${UNKNOWN}`).expect(401);
  });

  it('upcoming: one row per order and tier with its count, nearest first, only paid orders', async () => {
    const res = await held(buyerToken).expect(200);
    const body = res.body as Page;
    expect(body.pagination.total).toBe(3);
    expect(body.data.map((g) => [g.orderId, g.quantity, g.tierName])).toEqual([
      expect.arrayContaining([expect.any(String), expect.any(Number), 'Free']),
      expect.arrayContaining([expect.any(String), expect.any(Number), 'Free']),
      [orders.later, 1, 'Free later'],
    ]);
    const soon = body.data.filter((g) => g.event.id === EV_SOON);
    expect(soon.map((g) => g.quantity).sort()).toEqual([1, 2]);
    expect(soon.find((g) => g.orderId === orders.soonA)?.tickets).toHaveLength(
      2,
    );
    // The event's own zone and venue travel with the row.
    expect(soon[0].event.timezone).toBe('America/New_York');
    expect(soon[0].event.venueName).toBe('Eko Hall');
    expect(JSON.stringify(body)).not.toContain(orders.unpaid);
    expect(body.data.some((g) => g.event.id === EV_UNPAID)).toBe(false);
  });

  it('past: an event that is over and one called off, newest first; none of them under upcoming', async () => {
    const body = (await held(buyerToken, '?view=past').expect(200))
      .body as Page;
    expect(body.data.map((g) => g.event.id)).toEqual([EV_CALLED_OFF, EV_PAST]);
    const upcoming = (await held(buyerToken, '?view=upcoming').expect(200))
      .body as Page;
    expect(
      upcoming.data.some((g) => [EV_PAST, EV_CALLED_OFF].includes(g.event.id)),
    ).toBe(false);
  });

  it('pages: the second page continues, the total counts rows, a page past the end is empty', async () => {
    const first = (await held(buyerToken, '?perPage=2&page=1').expect(200))
      .body as Page;
    const second = (await held(buyerToken, '?perPage=2&page=2').expect(200))
      .body as Page;
    const beyond = (await held(buyerToken, '?perPage=2&page=3').expect(200))
      .body as Page;
    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    expect(first.pagination.total).toBe(3);
    expect(second.pagination.total).toBe(3);
    expect(first.pagination.nextPage).toBe(2);
    expect(second.pagination.nextPage).toBeNull();
    expect(beyond.data).toEqual([]);
    const ids = [...first.data, ...second.data].map((g) => g.orderId);
    expect(new Set(ids).size).toBe(3);
  });

  it('another person sees only their own', async () => {
    const body = (await held(otherToken).expect(200)).body as Page;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].orderId).toBe(orders.theirs);
    expect(
      (await held(otherToken, '?view=past').expect(200)).body as Page,
    ).toMatchObject({ data: [] });
  });

  it('odd inputs are refused, not guessed at', async () => {
    for (const qs of [
      '?view=bogus',
      '?view=',
      '?page=0',
      '?page=-1',
      '?page=1e8',
      '?page=99999',
      '?perPage=0',
      '?perPage=101',
      '?perPage=abc',
      '?extra=1',
    ]) {
      await held(buyerToken, qs).expect(400);
    }
    await http()
      .get('/api/hub/events/tickets/held/not-a-uuid')
      .set(auth(buyerToken))
      .expect(400);
    await one(buyerToken, UNKNOWN).expect(404);
  });

  it('one ticket: the code the door accepts, my name, the event, and the tickets beside it', async () => {
    const list = (await held(buyerToken).expect(200)).body as Page;
    const group = list.data.find((g) => g.orderId === orders.soonA)!;
    const [first, second] = group.tickets;
    const view = data<{
      id: string;
      code: string;
      status: string;
      checkedInAt: string | null;
      holderName: string | null;
      tierName: string;
      orderId: string;
      event: { id: string; name: string };
      siblings: { id: string }[];
    }>(await one(buyerToken, first.id).expect(200));
    expect(view).toMatchObject({
      id: first.id,
      status: 'valid',
      checkedInAt: null,
      holderName: 'Chidi Umeh',
      tierName: 'Free',
      orderId: orders.soonA,
    });
    expect(view.event).toMatchObject({ id: EV_SOON, name: 'Soon Summit' });
    expect(view.siblings.map((s) => s.id)).toEqual([first.id, second.id]);
    const row = await prisma.eventTicket.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(view.code).toBe(row.code);
  });

  it("someone else's ticket, an unpaid order's ticket and a made-up id all read 404", async () => {
    const theirs = await prisma.eventTicket.findFirstOrThrow({
      where: { orderId: orders.theirs },
    });
    const unpaid = await prisma.eventTicket.findFirstOrThrow({
      where: { orderId: orders.unpaid },
    });
    const a = await one(buyerToken, theirs.id).expect(404);
    const b = await one(buyerToken, unpaid.id).expect(404);
    const c = await one(buyerToken, UNKNOWN).expect(404);
    expect(a.body).toEqual(c.body);
    expect(b.body).toEqual(c.body);
  });

  it("the code in the ticket is what the door scans; afterwards the ticket reads checked in with the door's time (E12)", async () => {
    const mine = (await held(buyerToken).expect(200)).body as Page;
    const group = mine.data.find((g) => g.orderId === orders.soonB)!;
    const ticketId = group.tickets[0].id;
    const view = data<{ code: string }>(
      await one(buyerToken, ticketId).expect(200),
    );
    // Lower case and padded, as a scanner may send it.
    const scan = await http()
      .post(`/api/hub/events/${EV_SOON}/door/check-in`)
      .set(auth(hostToken))
      .send({ code: ` ${view.code.toLowerCase()} ` })
      .expect(201);
    const checked = data<{ outcome: string; ticket: { checkedInAt: string } }>(
      scan,
    );
    expect(checked.outcome).toBe('valid');
    const after = data<{ status: string; checkedInAt: string }>(
      await one(buyerToken, ticketId).expect(200),
    );
    expect(after.status).toBe('checked_in');
    expect(new Date(after.checkedInAt).getTime()).toBe(
      new Date(checked.ticket.checkedInAt).getTime(),
    );
    const row = (await held(buyerToken).expect(200)).body as Page;
    expect(
      row.data.find((g) => g.orderId === orders.soonB)!.tickets[0],
    ).toMatchObject({ status: 'checked_in' });
  });

  it('a ticket of a called-off event reads void', async () => {
    const t = await prisma.eventTicket.findFirstOrThrow({
      where: { orderId: orders.off },
    });
    await prisma.eventTicket.update({
      where: { id: t.id },
      data: { status: 'void' },
    });
    expect(
      data<{ status: string }>(await one(buyerToken, t.id).expect(200)).status,
    ).toBe('void');
  });

  it('the protected GET /events/tickets/mine keeps its keys', async () => {
    const rows = data<Record<string, unknown>[]>(
      await http()
        .get('/api/hub/events/tickets/mine')
        .set(auth(buyerToken))
        .expect(200),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(Object.keys(r).sort()).toEqual([
        'checkedInAt',
        'code',
        'event',
        'id',
        'status',
        'ticketType',
      ]);
  });
});
