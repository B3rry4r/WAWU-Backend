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

/**
 * EVENTS-11 (R-40, owner, 7 Oct 2026): PUT /events/:id/tickets follows the
 * rules POST and PATCH /events follow.
 *
 *  - the host needs a current tick: the same gate, the same 403 reasons and
 *    the same error body, before anything is written;
 *  - a tier change on a `published` event sends it back to `pending` (a
 *    stranger gets 404 until an admin approves it again), and on a
 *    `rejected` or `pending` event leaves it `pending`;
 *  - once a ticket is sold the 409 answers exactly as before, first;
 *  - the same tiers sent again change nothing, the status included.
 *
 * The fixtures are this suite's own event ids (`ee11...`), swept before and
 * after. The three seeded accounts are borrowed; their tick columns are
 * snapshotted and written back (README § Test hygiene).
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** A creator account: holds a live tick unless a test lapses it. */
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
/** A creator account that has never held a tick. */
const UNVERIFIED_EMAIL = 'creator-basic@test.wawu.dev';
const UNVERIFIED_SUB = '00000000-0000-4000-8000-000000000002';
/** A buyer (`user`) account: can hold no tick. Also the stranger. */
const BUYER_EMAIL = 'user@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000001';
const SUBS = [HOST_SUB, UNVERIFIED_SUB, BUYER_SUB];

const EV_LIVE = 'ee110000-0000-4000-8000-000000000001';
const EV_REJECTED = 'ee110000-0000-4000-8000-000000000002';
const EV_PENDING = 'ee110000-0000-4000-8000-000000000003';
const EV_REMOVED = 'ee110000-0000-4000-8000-000000000004';
const EV_UNVERIFIED = 'ee110000-0000-4000-8000-000000000005';
const EV_BUYER = 'ee110000-0000-4000-8000-000000000006';
const EV_CANCELLED = 'ee110000-0000-4000-8000-000000000007';
const EVENTS = [
  EV_LIVE,
  EV_REJECTED,
  EV_PENDING,
  EV_REMOVED,
  EV_UNVERIFIED,
  EV_BUYER,
  EV_CANCELLED,
];

const ADMIN_ID = 'ad110000-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'events11-super@admin.test.wawu.dev';
const ADMIN_PASSWORD = 'events-eleven-contract-password';

const FUTURE = new Date('2027-05-06T09:00:00.000Z');
const LIVE_TICK = {
  creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
};
const LAPSED_TICK = {
  creatorVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
  creatorVerifiedUntil: new Date('2025-01-01T00:00:00.000Z'),
};
const NO_TICK = {
  creatorVerifiedAt: null,
  creatorVerifiedUntil: null,
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};

/** The tier every fixture event was approved with. */
const OLD_TIER = {
  tier: 'regular' as const,
  name: 'Regular',
  priceNaira: 5000,
  quantity: 100,
};
/** The reprice a host sends. */
const NEW_TIERS = [
  { tier: 'regular', name: 'Regular', priceNaira: 7500, quantity: 100 },
];

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
  message: unknown;
  reason?: { code: string; message: string; steps: string[] };
}

describe('PUT /events/:id/tickets: the hosting gate and re-review (EVENTS-11, R-40)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let unverifiedToken: string;
  let buyerToken: string;
  let adminToken: string;
  const envSnapshot: Record<string, string | undefined> = {};
  const tickSnapshot = new Map<
    string,
    {
      creatorVerifiedAt: Date | null;
      creatorVerifiedUntil: Date | null;
      professionalVerifiedAt: Date | null;
      professionalVerifiedUntil: Date | null;
    }
  >();

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function sweep(): Promise<void> {
    await prisma.adminEventReview.deleteMany({
      where: { eventId: { in: EVENTS } },
    });
    // Ticket types and speakers cascade from Event.
    await prisma.event.deleteMany({ where: { id: { in: EVENTS } } });
  }

  async function setTick(sub: string, tick: object): Promise<void> {
    await prisma.userProfile.update({ where: { wawuUserId: sub }, data: tick });
  }

  /** One event with the old tier, at a status, hosted by `host`. */
  async function fixture(
    id: string,
    host: string,
    status: 'published' | 'pending' | 'rejected' | 'removed' | 'cancelled',
    extra: { cancelledAt?: Date } = {},
  ): Promise<void> {
    await prisma.event.create({
      data: {
        id,
        hostWawuId: host,
        name: `EV11 ${status} ${id.slice(-2)}`,
        description: 'A fixture for the EVENTS-11 contract suite.',
        hostOrg: 'EV11 Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: FUTURE,
        status,
        lastDecisionReason: 'A note from the last decision.',
        ...extra,
        ticketTypes: { create: [OLD_TIER] },
      },
    });
  }

  /** Everything this route can write, to prove a refusal wrote none of it. */
  async function snapshot(id: string) {
    const event = await prisma.event.findUniqueOrThrow({
      where: { id },
      select: { status: true, lastDecisionReason: true, updatedAt: true },
    });
    const tiers = await prisma.eventTicketType.findMany({
      where: { eventId: id },
      orderBy: { id: 'asc' },
    });
    return { event, tiers };
  }

  function put(token: string, id: string, types: unknown = NEW_TIERS) {
    return http()
      .put(`/api/hub/events/${id}/tickets`)
      .set(auth(token))
      .send({ types });
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = 'events-eleven-access-secret-0123456789ab';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'events-eleven-refresh-secret-0123456789ab';

    [hostToken, unverifiedToken, buyerToken] = await Promise.all([
      login(HOST_EMAIL),
      login(UNVERIFIED_EMAIL),
      login(BUYER_EMAIL),
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

    const argon2 = await import('argon2');
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.adminUser.create({
      data: {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        name: 'EV11 Super',
        role: 'superadmin',
        passwordHash: await argon2.hash(ADMIN_PASSWORD),
      },
    });
    const adminLogin = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    adminToken = (adminLogin.body as { data: { accessToken: string } }).data
      .accessToken;

    for (const sub of SUBS) {
      const row = await prisma.userProfile.findUnique({
        where: { wawuUserId: sub },
        select: {
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      });
      if (row) tickSnapshot.set(sub, row);
    }
    // The buyer must be a buyer for the account_type_required case.
    expect(
      (
        await prisma.userProfile.findUniqueOrThrow({
          where: { wawuUserId: BUYER_SUB },
        })
      ).accountType,
    ).toBe('user');
    expect(
      await prisma.professionalProfile.count({
        where: { wawuUserId: BUYER_SUB, status: 'approved' },
      }),
    ).toBe(0);
  });

  beforeEach(async () => {
    await sweep();
    await setTick(HOST_SUB, { ...NO_TICK, ...LIVE_TICK });
    await setTick(UNVERIFIED_SUB, NO_TICK);
    await setTick(BUYER_SUB, NO_TICK);
    await fixture(EV_LIVE, HOST_SUB, 'published');
  });

  afterAll(async () => {
    await sweep();
    for (const [sub, row] of tickSnapshot) await setTick(sub, row);
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a verified host reprices an approved event: 200, pending, a stranger gets 404, an admin approves, the new price is public', async () => {
    const res = await put(hostToken, EV_LIVE).expect(200);
    const tiers = (res.body as { data: { name: string; priceNaira: number }[] })
      .data;
    expect(tiers.map((t) => [t.name, t.priceNaira])).toEqual([
      ['Regular', 7500],
    ]);

    // Back to review, with the old decision note cleared, as PATCH does.
    const row = await prisma.event.findUniqueOrThrow({
      where: { id: EV_LIVE },
    });
    expect(row.status).toBe('pending');
    expect(row.lastDecisionReason).toBeNull();

    // A stranger is told nothing; the host still reads it.
    await http()
      .get(`/api/hub/events/${EV_LIVE}`)
      .set(auth(buyerToken))
      .expect(404);
    const list = await http()
      .get('/api/hub/events')
      .query({ perPage: 100 })
      .set(auth(buyerToken))
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.map((e) => e.id),
    ).not.toContain(EV_LIVE);
    const own = await http()
      .get(`/api/hub/events/${EV_LIVE}`)
      .set(auth(hostToken))
      .expect(200);
    expect((own.body as { data: { status: string } }).data.status).toBe(
      'pending',
    );

    // It is in the admin queue, and an approve makes the new price public.
    await http()
      .post(`/api/hub/admin/events/${EV_LIVE}/approve`)
      .set(auth(adminToken))
      .expect(200);
    const pub = await http()
      .get(`/api/hub/events/${EV_LIVE}`)
      .set(auth(buyerToken))
      .expect(200);
    const view = (
      pub.body as { data: { status: string; priceFromNaira: number } }
    ).data;
    expect(view.status).toBe('published');
    expect(view.priceFromNaira).toBe(7500);
    const pubTiers = await http()
      .get(`/api/hub/events/${EV_LIVE}/tickets`)
      .set(auth(buyerToken))
      .expect(200);
    expect(
      (pubTiers.body as { data: { priceNaira: number }[] }).data.map(
        (t) => t.priceNaira,
      ),
    ).toEqual([7500]);
  });

  it('the same host with the tick lapsed: 403 verification_required, the error POST and PATCH give, nothing written, still public at the old price', async () => {
    await setTick(HOST_SUB, LAPSED_TICK);
    const before = await snapshot(EV_LIVE);

    const res = await put(hostToken, EV_LIVE).expect(403);
    const body = res.body as ErrorBody;
    expect(body.reason?.code).toBe('verification_required');

    // The same body, word for word, as the event routes' own gate.
    const patch = await http()
      .patch(`/api/hub/events/${EV_LIVE}`)
      .set(auth(hostToken))
      .send({ name: 'EV11 renamed' })
      .expect(403);
    expect(body).toEqual(patch.body);

    expect(await snapshot(EV_LIVE)).toEqual(before);
    const pub = await http()
      .get(`/api/hub/events/${EV_LIVE}`)
      .set(auth(buyerToken))
      .expect(200);
    expect(
      (pub.body as { data: { status: string; priceFromNaira: number } }).data,
    ).toMatchObject({ status: 'published', priceFromNaira: 5000 });
  });

  it('a lapsed host sending the same tiers is refused too (the gate runs before the no-change answer)', async () => {
    await setTick(HOST_SUB, LAPSED_TICK);
    const before = await snapshot(EV_LIVE);
    const res = await put(hostToken, EV_LIVE, [OLD_TIER]).expect(403);
    expect((res.body as ErrorBody).reason?.code).toBe('verification_required');
    expect(await snapshot(EV_LIVE)).toEqual(before);
  });

  it('a never-verified creator: 403 verification_required, nothing written', async () => {
    await fixture(EV_UNVERIFIED, UNVERIFIED_SUB, 'published');
    const before = await snapshot(EV_UNVERIFIED);

    const res = await put(unverifiedToken, EV_UNVERIFIED).expect(403);
    const body = res.body as ErrorBody;
    expect(body.statusCode).toBe(403);
    expect(body.reason?.code).toBe('verification_required');
    const post = await http()
      .post('/api/hub/events')
      .set(auth(unverifiedToken))
      .send({
        name: 'EV11 refused',
        description: 'Refused before it is written.',
        hostOrg: 'EV11',
        format: 'online',
        type: 'meetup',
        startsAt: FUTURE.toISOString(),
        location: 'Online',
      })
      .expect(403);
    expect(body).toEqual(post.body);

    expect(await snapshot(EV_UNVERIFIED)).toEqual(before);
  });

  it('a buyer account: 403 account_type_required, nothing written', async () => {
    // An event a buyer account still holds (a host who switched account type).
    await fixture(EV_BUYER, BUYER_SUB, 'published');
    const before = await snapshot(EV_BUYER);

    const res = await put(buyerToken, EV_BUYER).expect(403);
    const body = res.body as ErrorBody;
    expect(body.statusCode).toBe(403);
    expect(body.reason?.code).toBe('account_type_required');
    const patch = await http()
      .patch(`/api/hub/events/${EV_BUYER}`)
      .set(auth(buyerToken))
      .send({ name: 'EV11 renamed' })
      .expect(403);
    expect(body).toEqual(patch.body);

    expect(await snapshot(EV_BUYER)).toEqual(before);
  });

  it('one ticket sold: 409 as before, checked first, nothing written, for a verified and a lapsed host alike', async () => {
    await prisma.eventTicketType.updateMany({
      where: { eventId: EV_LIVE },
      data: { sold: 1 },
    });
    const before = await snapshot(EV_LIVE);

    const res = await put(hostToken, EV_LIVE).expect(409);
    expect((res.body as ErrorBody).message).toBe(
      'Tickets have already sold for "Regular". Add a new tier instead of editing one people have bought.',
    );
    expect(await snapshot(EV_LIVE)).toEqual(before);

    await setTick(HOST_SUB, LAPSED_TICK);
    const lapsed = await put(hostToken, EV_LIVE).expect(409);
    expect((lapsed.body as ErrorBody).message).toBe(
      (res.body as ErrorBody).message,
    );
    expect(await snapshot(EV_LIVE)).toEqual(before);
  });

  it('the same tiers sent again change nothing: 200, still published, the same rows', async () => {
    const before = await snapshot(EV_LIVE);
    const res = await put(hostToken, EV_LIVE, [OLD_TIER]).expect(200);
    expect(
      (res.body as { data: { id: string }[] }).data.map((t) => t.id),
    ).toEqual(before.tiers.map((t) => t.id));
    expect(await snapshot(EV_LIVE)).toEqual(before);
  });

  it('a change to any one field is a change (quantity), and goes to review', async () => {
    await put(hostToken, EV_LIVE, [{ ...OLD_TIER, quantity: 101 }]).expect(200);
    expect(
      (await prisma.event.findUniqueOrThrow({ where: { id: EV_LIVE } })).status,
    ).toBe('pending');
  });

  it('a rejected event goes to pending with its note cleared; a pending event stays pending', async () => {
    await fixture(EV_REJECTED, HOST_SUB, 'rejected');
    await fixture(EV_PENDING, HOST_SUB, 'pending');
    await put(hostToken, EV_REJECTED).expect(200);
    await put(hostToken, EV_PENDING).expect(200);
    for (const id of [EV_REJECTED, EV_PENDING]) {
      const row = await prisma.event.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('pending');
      expect(row.lastDecisionReason).toBeNull();
    }
  });

  it('a removed event: 403 with the takedown body PATCH gives, nothing written, so a restore publishes nothing unseen (round 4 ruling)', async () => {
    await fixture(EV_REMOVED, HOST_SUB, 'removed');
    const before = await snapshot(EV_REMOVED);
    const res = await put(hostToken, EV_REMOVED).expect(403);
    const patch = await http()
      .patch(`/api/hub/events/${EV_REMOVED}`)
      .set(auth(hostToken))
      .send({ name: 'EV11 renamed' })
      .expect(403);
    expect(res.body).toEqual(patch.body);
    expect((res.body as ErrorBody).message).toBe(
      'This event was taken down by an admin and cannot be edited. Submit a new one, or contact support.',
    );
    // The same tiers sent again are refused too: a takedown is not editable.
    await put(hostToken, EV_REMOVED, [OLD_TIER]).expect(403);
    expect(await snapshot(EV_REMOVED)).toEqual(before);

    // After a restore the public reads the tiers it read before the takedown.
    await http()
      .post(`/api/hub/admin/events/${EV_REMOVED}/restore`)
      .set(auth(adminToken))
      .expect(200);
    const pub = await http()
      .get(`/api/hub/events/${EV_REMOVED}/tickets`)
      .set(auth(buyerToken))
      .expect(200);
    expect(
      (pub.body as { data: { name: string; priceNaira: number }[] }).data,
    ).toMatchObject([{ name: 'Regular', priceNaira: 5000 }]);
  });

  it('keeps the checks that ran before: not yours 403, cancelled 409, a ₦0 paid tier 400, each before the gate', async () => {
    // Somebody else's event: the old 403, even from an account the gate refuses.
    const notYours = await put(unverifiedToken, EV_LIVE).expect(403);
    expect((notYours.body as ErrorBody).message).toBe(
      'This event is not yours.',
    );
    expect((notYours.body as ErrorBody).reason).toBeUndefined();

    await fixture(EV_CANCELLED, HOST_SUB, 'published', {
      cancelledAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await setTick(HOST_SUB, LAPSED_TICK);
    const cancelled = await put(hostToken, EV_CANCELLED).expect(409);
    expect((cancelled.body as ErrorBody).message).toBe(
      'This event has been cancelled.',
    );

    const zero = await put(hostToken, EV_LIVE, [
      { tier: 'vip', name: 'VIP', priceNaira: 0, quantity: 10 },
    ]).expect(400);
    expect(String((zero.body as ErrorBody).message)).toContain(
      '"VIP" is a paid tier',
    );
  });

  // ── R-42: who reads the tiers ─────────────────────────────────────────────

  it('F3: the tiers of an event that is not published are a 404 to everyone but its host, as GET /events/:id is', async () => {
    await fixture(EV_PENDING, HOST_SUB, 'pending');
    await fixture(EV_REJECTED, HOST_SUB, 'rejected');
    await fixture(EV_REMOVED, HOST_SUB, 'removed');
    await fixture(EV_CANCELLED, HOST_SUB, 'cancelled', {
      cancelledAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    for (const id of [EV_PENDING, EV_REJECTED, EV_REMOVED, EV_CANCELLED]) {
      // A stranger, a signed-out reader: 404, the same answer the event gets.
      const tiers = await http()
        .get(`/api/hub/events/${id}/tickets`)
        .set(auth(buyerToken))
        .expect(404);
      const event = await http()
        .get(`/api/hub/events/${id}`)
        .set(auth(buyerToken))
        .expect(404);
      expect(tiers.body).toEqual(event.body);
      await http().get(`/api/hub/events/${id}/tickets`).expect(404);
      // The host reads their own tiers at any status.
      const own = await http()
        .get(`/api/hub/events/${id}/tickets`)
        .set(auth(hostToken))
        .expect(200);
      expect(
        (own.body as { data: { priceNaira: number }[] }).data.map(
          (t) => t.priceNaira,
        ),
      ).toEqual([5000]);
    }
  });

  it("F3: a published event's tiers are public as before, signed in or out, and a missing event keeps its answers", async () => {
    for (const token of [buyerToken, null]) {
      const req = http().get(`/api/hub/events/${EV_LIVE}/tickets`);
      const res = await (token ? req.set(auth(token)) : req).expect(200);
      expect(
        (res.body as { data: { name: string; priceNaira: number }[] }).data,
      ).toMatchObject([{ name: 'Regular', priceNaira: 5000 }]);
    }
    const missing = 'ee110000-0000-4000-8000-0000000000ff';
    await http()
      .get(`/api/hub/events/${missing}/tickets`)
      .set(auth(buyerToken))
      .expect(404);
    const anon = await http()
      .get(`/api/hub/events/${missing}/tickets`)
      .expect(200);
    expect((anon.body as { data: unknown[] }).data).toEqual([]);
  });

  it('F3: the moment a repriced event goes back to review, its new tiers are hidden too; the host still reads them', async () => {
    await put(hostToken, EV_LIVE).expect(200);
    await http()
      .get(`/api/hub/events/${EV_LIVE}/tickets`)
      .set(auth(buyerToken))
      .expect(404);
    await http().get(`/api/hub/events/${EV_LIVE}/tickets`).expect(404);
    await http()
      .get(`/api/hub/events/${EV_LIVE}/tickets`)
      .set(auth(hostToken))
      .expect(200);
  });

  it('F2: the admin queue and the admin event detail carry the ticket types the reviewer approves', async () => {
    await put(hostToken, EV_LIVE, [
      { tier: 'vip', name: 'VIP', priceNaira: 20000, quantity: 10 },
      ...NEW_TIERS,
    ]).expect(200);
    const want = [
      {
        tier: 'regular',
        name: 'Regular',
        priceNaira: 7500,
        quantity: 100,
        sold: 0,
      },
      { tier: 'vip', name: 'VIP', priceNaira: 20000, quantity: 10, sold: 0 },
    ];
    type Tier = (typeof want)[number] & { id: string };

    const queue = await http()
      .get('/api/hub/admin/events/queue')
      .query({ perPage: 100 })
      .set(auth(adminToken))
      .expect(200);
    const row = (
      queue.body as { data: { id: string; ticketTypes: Tier[] }[] }
    ).data.find((e) => e.id === EV_LIVE);
    expect(row?.ticketTypes).toMatchObject(want);
    expect(Object.keys(row!.ticketTypes[0]).sort()).toEqual(
      ['id', 'name', 'priceNaira', 'quantity', 'sold', 'tier'].sort(),
    );

    const detail = await http()
      .get(`/api/hub/admin/events/${EV_LIVE}`)
      .set(auth(adminToken))
      .expect(200);
    const tiers = (detail.body as { data: { ticketTypes: Tier[] } }).data
      .ticketTypes;
    expect(tiers).toMatchObject(want);
    const rows = await prisma.eventTicketType.findMany({
      where: { eventId: EV_LIVE },
      orderBy: { priceNaira: 'asc' },
    });
    expect(tiers.map((t) => t.id)).toEqual(rows.map((r) => r.id));

    // An event with no ticket types: an empty list, not a missing field.
    await prisma.eventTicketType.deleteMany({ where: { eventId: EV_LIVE } });
    const bare = await http()
      .get(`/api/hub/admin/events/${EV_LIVE}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      (bare.body as { data: { ticketTypes: Tier[] } }).data.ticketTypes,
    ).toEqual([]);
  });

  it('F2: the admin browse list and the decision answers keep the shape they had (no ticketTypes)', async () => {
    const list = await http()
      .get('/api/hub/admin/events')
      .query({ perPage: 100 })
      .set(auth(adminToken))
      .expect(200);
    const row = (list.body as { data: Record<string, unknown>[] }).data.find(
      (e) => e.id === EV_LIVE,
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('ticketTypes');

    await put(hostToken, EV_LIVE).expect(200);
    const approved = await http()
      .post(`/api/hub/admin/events/${EV_LIVE}/approve`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      (approved.body as { data: { event: Record<string, unknown> } }).data
        .event,
    ).not.toHaveProperty('ticketTypes');
  });
});
