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
import { EventModule } from '../event.module';

/**
 * EVENTS-02: what the app's host wizard (E13 to E16) submits.
 *
 *  - a host sends the event and its ticket types in ONE request, and both go
 *    to review together (the task's capability check);
 *  - a ₦0 ticket is the free tier without the host naming one (R-8);
 *  - the hybrid format and the Conference and Concert kinds are accepted and
 *    filterable;
 *  - `location`, which no wizard step asks for, can be left out;
 *  - GET /events/options maps every label to the value to send
 *    ("Business & Finance" is `business`).
 *
 * Every event here is named with the `EV02 ` prefix and swept by that prefix,
 * so the seeded accounts this borrows keep every other suite's rows. Their
 * tick columns are snapshotted and written back (README § Test hygiene).
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
const UNVERIFIED_EMAIL = 'creator-basic@test.wawu.dev';
const UNVERIFIED_SUB = '00000000-0000-4000-8000-000000000002';
const SUBS = [HOST_SUB, UNVERIFIED_SUB];

const PREFIX = 'EV02 ';
const FUTURE = '2027-05-09T13:00:00.000Z';
const FUTURE_END = '2027-05-09T16:00:00.000Z';

async function loginToWawuId(identifier: string): Promise<string> {
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

/** The success and error envelopes, as far as this suite reads them. */
interface Envelope<T> {
  data: T;
  message?: unknown;
  reason?: { code: string };
}
interface EventWire {
  id: string;
  status: string;
  format: string;
  type: string;
  location: string;
  address: string | null;
  ticketed: boolean;
  priceFromNaira: number | null;
}
function bodyOf<T = EventWire>(res: request.Response): Envelope<T> {
  return res.body as Envelope<T>;
}
function dataOf<T = EventWire>(res: request.Response): T {
  return bodyOf<T>(res).data;
}

/** What E13 to E15 collect, and nothing they do not: no `location`. */
function wizardBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `${PREFIX}Pricing your work without guessing`,
    description: 'Three hours on the numbers behind a price.',
    hostOrg: 'Adeyemi & Co',
    format: 'in_person',
    type: 'workshop',
    startsAt: FUTURE,
    endsAt: FUTURE_END,
    address: 'Water Corporation Road, Victoria Island',
    category: 'business',
    ticketTypes: [
      { name: 'Regular', priceNaira: 5000, quantity: 100 },
      { name: 'VIP', priceNaira: 12000, quantity: 20 },
    ],
    ...overrides,
  };
}

describe('Event hosting, one submit (EVENTS-02)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let unverifiedToken: string;

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const TICK_COLUMNS = {
    creatorVerifiedAt: true,
    creatorVerifiedUntil: true,
    professionalVerifiedAt: true,
    professionalVerifiedUntil: true,
  } as const;
  const tickSnapshot = new Map<
    string,
    {
      creatorVerifiedAt: Date | null;
      creatorVerifiedUntil: Date | null;
      professionalVerifiedAt: Date | null;
      professionalVerifiedUntil: Date | null;
    }
  >();

  async function sweep(): Promise<void> {
    // EventTicketType and EventSpeaker cascade from Event.
    await prisma.event.deleteMany({
      where: { hostWawuId: { in: SUBS }, name: { startsWith: PREFIX } },
    });
  }

  async function submitted(name: string) {
    return prisma.event.findMany({
      where: { hostWawuId: { in: SUBS }, name },
      include: { ticketTypes: { orderBy: { priceNaira: 'asc' } } },
    });
  }

  beforeAll(async () => {
    [hostToken, unverifiedToken] = await Promise.all([
      loginToWawuId(HOST_EMAIL),
      loginToWawuId(UNVERIFIED_EMAIL),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        EventModule,
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

    for (const sub of SUBS) {
      const row = await prisma.userProfile.findUnique({
        where: { wawuUserId: sub },
        select: TICK_COLUMNS,
      });
      if (row) tickSnapshot.set(sub, row);
    }
    await prisma.userProfile.update({
      where: { wawuUserId: HOST_SUB },
      data: {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await prisma.userProfile.update({
      where: { wawuUserId: UNVERIFIED_SUB },
      data: {
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      },
    });
    await sweep();
  });

  afterEach(async () => {
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    for (const [sub, snapshot] of tickSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: sub },
        data: snapshot,
      });
    }
    await app.close();
  });

  describe('POST /api/hub/events with ticket types', () => {
    it('a host submits an event with two ticket types in one request and it goes to review', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(wizardBody())
        .expect(201);

      expect(dataOf(res).status).toBe('pending');
      expect(dataOf(res).ticketed).toBe(true);
      expect(dataOf(res).priceFromNaira).toBe(5000);

      const [row] = await submitted(
        `${PREFIX}Pricing your work without guessing`,
      );
      expect(row.status).toBe('pending');
      expect(
        row.ticketTypes.map((t) => ({
          tier: t.tier,
          name: t.name,
          priceNaira: t.priceNaira,
          quantity: t.quantity,
          sold: t.sold,
        })),
      ).toEqual([
        {
          tier: 'regular',
          name: 'Regular',
          priceNaira: 5000,
          quantity: 100,
          sold: 0,
        },
        {
          tier: 'regular',
          name: 'VIP',
          priceNaira: 12000,
          quantity: 20,
          sold: 0,
        },
      ]);

      // In review: the host sees it, nobody else does.
      const mine = await http()
        .get('/api/hub/events/mine')
        .set(auth(hostToken))
        .expect(200);
      expect(
        dataOf<{ id: string; status: string }[]>(mine).find(
          (e) => e.id === row.id,
        )?.status,
      ).toBe('pending');
      await http()
        .get(`/api/hub/events/${row.id}`)
        .set(auth(unverifiedToken))
        .expect(404);
      const pub = await http()
        .get('/api/hub/events')
        .set(auth(unverifiedToken))
        .expect(200);
      expect(dataOf<{ id: string }[]>(pub).map((e) => e.id)).not.toContain(
        row.id,
      );
    });

    it('keeps a tier the host names', async () => {
      const name = `${PREFIX}Named tiers`;
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({
            name,
            ticketTypes: [
              {
                name: 'Early bird',
                priceNaira: 3000,
                quantity: 50,
                tier: 'early_bird',
              },
              { name: 'VIP', priceNaira: 12000, quantity: 20, tier: 'vip' },
            ],
          }),
        )
        .expect(201);
      const [row] = await submitted(name);
      expect(row.ticketTypes.map((t) => t.tier)).toEqual(['early_bird', 'vip']);
    });

    it('makes a ₦0 ticket the free tier without the host naming one (R-8)', async () => {
      const name = `${PREFIX}Free meetup`;
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({
            name,
            ticketTypes: [{ name: 'Entry', priceNaira: 0, quantity: 300 }],
          }),
        )
        .expect(201);
      expect(dataOf(res).ticketed).toBe(true);
      expect(dataOf(res).priceFromNaira).toBe(0);

      const [row] = await submitted(name);
      expect(row.ticketTypes).toHaveLength(1);
      expect(row.ticketTypes[0].tier).toBe('free');
      expect(row.ticketTypes[0].priceNaira).toBe(0);
    });

    it('refuses a ₦0 paid tier and a priced free tier, and saves nothing', async () => {
      const name = `${PREFIX}Refused tiers`;
      const zeroVip = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({
            name,
            ticketTypes: [
              { name: 'Regular', priceNaira: 5000, quantity: 100 },
              { name: 'VIP', priceNaira: 0, quantity: 20, tier: 'vip' },
            ],
          }),
        )
        .expect(400);
      expect(String(bodyOf(zeroVip).message)).toContain(
        '"VIP" is a paid tier, so it needs a price above zero.',
      );

      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({
            name,
            ticketTypes: [
              { name: 'Free', priceNaira: 500, quantity: 20, tier: 'free' },
            ],
          }),
        )
        .expect(400);

      // One write: a refused ticket type leaves no event behind it.
      expect(await submitted(name)).toHaveLength(0);
    });

    it('400s ticket types in a shape the wizard never sends', async () => {
      const name = `${PREFIX}Bad shapes`;
      for (const ticketTypes of [
        [{ name: 'Regular', priceNaira: '5,000', quantity: 100 }],
        [{ name: 'Regular', priceNaira: 5000.5, quantity: 100 }],
        [{ name: 'Regular', priceNaira: -1, quantity: 100 }],
        [{ name: 'Regular', priceNaira: 5000, quantity: 0 }],
        [{ name: 'Regular', priceNaira: 5000 }],
        [{ name: ' ', priceNaira: 5000, quantity: 10 }],
        [{ name: 'Regular', priceNaira: 5000, quantity: 10, tier: 'platinum' }],
        [{ name: 'Regular', priceNaira: 5000, quantity: 10, sold: 5 }],
        [{ name: 'Regular', priceKobo: 500000, quantity: 10 }],
        { name: 'Regular', priceNaira: 5000, quantity: 10 },
      ]) {
        await http()
          .post('/api/hub/events')
          .set(auth(hostToken))
          .send(wizardBody({ name, ticketTypes }))
          .expect(400);
      }
      expect(await submitted(name)).toHaveLength(0);
    });

    it('400s a price or quantity that is not a JSON integer, as PUT /events/:id/tickets does, and saves nothing', async () => {
      const name = `${PREFIX}Not integers`;
      const bad: Array<[string, unknown, unknown]> = [
        ['priceNaira', '', 10],
        ['priceNaira', '5000', 10],
        ['priceNaira', true, 10],
        ['priceNaira', '0x10', 10],
        ['priceNaira', '1e3', 10],
        ['priceNaira', '5,000', 10],
        ['priceNaira', null, 10],
        ['quantity', '', 5000],
        ['quantity', '10', 5000],
        ['quantity', true, 5000],
        ['quantity', '0x10', 5000],
        ['quantity', null, 5000],
      ];
      for (const [field, value, other] of bad) {
        const ticket =
          field === 'priceNaira'
            ? { name: 'Regular', priceNaira: value, quantity: other }
            : { name: 'Regular', priceNaira: other, quantity: value };
        const res = await http()
          .post('/api/hub/events')
          .set(auth(hostToken))
          .send(wizardBody({ name, ticketTypes: [ticket] }))
          .expect(400);
        const message = JSON.stringify(bodyOf(res).message);
        expect(message).toContain(`${field} must be a whole number`);
      }
      expect(await submitted(name)).toHaveLength(0);
    });

    it('refuses an unverified host with ticket types, and saves nothing', async () => {
      const name = `${PREFIX}Unverified host`;
      const res = await http()
        .post('/api/hub/events')
        .set(auth(unverifiedToken))
        .send(wizardBody({ name }))
        .expect(403);
      expect(bodyOf(res).reason?.code).toBe('verification_required');
      expect(await submitted(name)).toHaveLength(0);
    });

    it('still takes an event with no ticket types, unticketed as before', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(wizardBody({ name: `${PREFIX}No tickets`, ticketTypes: [] }))
        .expect(201);
      expect(dataOf(res).ticketed).toBe(false);
      expect(dataOf(res).priceFromNaira).toBeNull();
    });
  });

  describe('hybrid events and the Conference and Concert kinds', () => {
    it('accepts each, and the host reads back what was sent', async () => {
      for (const [format, type] of [
        ['hybrid', 'conference'],
        ['online', 'concert'],
      ]) {
        const res = await http()
          .post('/api/hub/events')
          .set(auth(hostToken))
          .send(
            wizardBody({ name: `${PREFIX}${format} ${type}`, format, type }),
          )
          .expect(201);
        expect(dataOf(res).format).toBe(format);
        expect(dataOf(res).type).toBe(type);
      }
    });

    it('filters the public list on them once approved', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({
            name: `${PREFIX}Hybrid concert`,
            format: 'hybrid',
            type: 'concert',
          }),
        )
        .expect(201);
      // Approval is the admin module's; this suite stands in for it on the row.
      await prisma.event.update({
        where: { id: dataOf(res).id },
        data: { status: 'published' },
      });

      for (const query of [
        'format=hybrid',
        'type=concert',
        'format=hybrid&type=concert',
      ]) {
        const list = await http()
          .get(`/api/hub/events?${query}`)
          .set(auth(unverifiedToken))
          .expect(200);
        expect(dataOf<{ id: string }[]>(list).map((e) => e.id)).toContain(
          dataOf(res).id,
        );
      }
      const inPerson = await http()
        .get('/api/hub/events?format=in_person')
        .set(auth(unverifiedToken))
        .expect(200);
      expect(dataOf<{ id: string }[]>(inPerson).map((e) => e.id)).not.toContain(
        dataOf(res).id,
      );
    });
  });

  describe('location, which no wizard step asks for', () => {
    it('is filled from the street address when left out', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(wizardBody({ name: `${PREFIX}Location from address` }))
        .expect(201);
      expect(dataOf(res).location).toBe(
        'Water Corporation Road, Victoria Island',
      );
      expect(dataOf(res).address).toBe(
        'Water Corporation Road, Victoria Island',
      );
    });

    it('is an empty string, never null, with no address either, and follows the address added later', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({
            name: `${PREFIX}No address yet`,
            address: undefined,
            format: 'online',
          }),
        )
        .expect(201);
      expect(dataOf(res).location).toBe('');

      const edited = await http()
        .patch(`/api/hub/events/${dataOf(res).id}`)
        .set(auth(hostToken))
        .send({ address: '12 Admiralty Way, Lekki' })
        .expect(200);
      expect(dataOf(edited).location).toBe('12 Admiralty Way, Lekki');
      expect(dataOf(edited).status).toBe('pending');
    });

    it('is stored as sent when sent, and an address edit leaves it alone', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          wizardBody({ name: `${PREFIX}Typed location`, location: 'Lagos' }),
        )
        .expect(201);
      expect(dataOf(res).location).toBe('Lagos');

      const edited = await http()
        .patch(`/api/hub/events/${dataOf(res).id}`)
        .set(auth(hostToken))
        .send({ address: '1 Marina, Lagos Island' })
        .expect(200);
      expect(dataOf(edited).location).toBe('Lagos');
    });

    it('400s a blank location when one is sent', async () => {
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(wizardBody({ name: `${PREFIX}Blank location`, location: '   ' }))
        .expect(400);
    });
  });

  describe('GET /api/hub/events/options', () => {
    it('maps every label to the value to send: "Business & Finance" is business', async () => {
      const res = await http()
        .get('/api/hub/events/options')
        .set(auth(unverifiedToken))
        .expect(200);
      const { categories, formats, types } =
        dataOf<
          Record<
            'categories' | 'formats' | 'types',
            { value: string; label: string }[]
          >
        >(res);

      expect(
        categories.find((c) => c.label === 'Business & Finance')?.value,
      ).toBe('business');
      expect(formats).toEqual([
        { value: 'in_person', label: 'In person' },
        { value: 'online', label: 'Online' },
        { value: 'hybrid', label: 'Hybrid' },
      ]);
      expect(types.slice(0, 4).map((t) => t.label)).toEqual([
        'Conference',
        'Workshop',
        'Concert',
        'Meetup',
      ]);

      // Every value the server accepts, once each.
      expect(categories.map((c) => c.value).sort()).toEqual(
        [
          'business',
          'church',
          'community',
          'conference',
          'entertainment',
          'fashion',
          'lifestyle',
          'music',
          'other',
          'training',
        ].sort(),
      );
      expect(types.map((t) => t.value).sort()).toEqual(
        [
          'competition',
          'concert',
          'conference',
          'meetup',
          'summit',
          'webinar',
          'workshop',
        ].sort(),
      );
      for (const list of [categories, formats, types]) {
        for (const o of list) expect(o.label).not.toMatch(/—/);
      }
    });

    it('is not mistaken for an event id, and needs a signed-in user', async () => {
      await http().get('/api/hub/events/options').expect(401);
    });

    it('every category it offers is accepted by a submit', async () => {
      const res = await http()
        .get('/api/hub/events/options')
        .set(auth(hostToken))
        .expect(200);
      for (const c of dataOf<{ categories: { value: string }[] }>(res)
        .categories) {
        await http()
          .post('/api/hub/events')
          .set(auth(hostToken))
          .send(
            wizardBody({
              name: `${PREFIX}Category ${c.value}`,
              category: c.value,
              ticketTypes: [],
            }),
          )
          .expect(201);
      }
    });
  });
});
