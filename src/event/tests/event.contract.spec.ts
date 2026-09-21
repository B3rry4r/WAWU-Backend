import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../event.module';

/**
 * Contract tests for the app-facing Events surface, reinstated 22 Aug 2026 by
 * product-owner decision.
 *
 * What this file is here to prove:
 *  - a submitted event is `pending` and is on NO public read path;
 *  - only its host can see it or edit it, and a stranger gets a 404 rather
 *    than a 403 (a 403 would confirm the id exists);
 *  - every host edit returns the event to `pending`, so approval cannot be
 *    bypassed by editing after the fact;
 *  - a `removed` event cannot be edited out of;
 *  - the "going" signal is idempotent in BOTH directions and is one row per
 *    person;
 *  - and, load-bearing for the product rule: the surface takes no money. A
 *    request carrying `price` is a 400, not a silently-ignored field.
 *
 * The moderation half — approve, reject, feature, takedown, roles — is
 * src/admin/events/tests/admin-events.contract.spec.ts, which mounts this same
 * unmodified EventModule and proves approval against the REAL public list.
 *
 * Fixtures live under this suite's own `ee……` id prefix and are swept in
 * afterAll (README § Test hygiene). No seeded row is read or mutated.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded mock WAWU ID identities. The mock keys login on the identifier, not the sub. */
const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
const STRANGER_EMAIL = 'creator-basic@test.wawu.dev';
const STRANGER_SUB = '00000000-0000-4000-8000-000000000002';
const THIRD_EMAIL = 'creator-pro@test.wawu.dev';
const THIRD_SUB = '00000000-0000-4000-8000-000000000003';
const ALL_SUBS = [HOST_SUB, STRANGER_SUB, THIRD_SUB];

// ── suite-owned event fixtures ──────────────────────────────────────────────
const EV_PUBLISHED = 'ee000000-0000-4000-8000-000000000001';
const EV_PUBLISHED_PAST = 'ee000000-0000-4000-8000-000000000002';
const EV_PENDING = 'ee000000-0000-4000-8000-000000000003';
const EV_REJECTED = 'ee000000-0000-4000-8000-000000000004';
const EV_REMOVED = 'ee000000-0000-4000-8000-000000000005';
const EV_OTHER_HOST = 'ee000000-0000-4000-8000-000000000006';
const UNKNOWN_EVENT = 'ee000000-0000-4000-8000-0000000000ff';

const FUTURE = new Date('2027-03-04T09:00:00.000Z');
const PAST = new Date('2025-03-04T09:00:00.000Z');

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

/** A minimal valid submission. Spread and override per test. */
function validEventBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Lagos Makers Workshop',
    description: 'A hands-on afternoon for craft sellers.',
    hostOrg: 'Makers Collective',
    format: 'in_person',
    type: 'workshop',
    startsAt: FUTURE.toISOString(),
    location: 'Lagos',
    ...overrides,
  };
}

describe('Events contract (app-facing)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let hostToken: string;
  let strangerToken: string;
  let thirdToken: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Anything this suite created, fixture or otherwise. */
  async function sweep(): Promise<void> {
    await prisma.adminEventReview.deleteMany({
      where: { hostWawuId: { in: ALL_SUBS } },
    });
    // EventSpeaker, EventGoing, EventSave and EventTicketType all cascade
    // from Event.
    await prisma.event.deleteMany({ where: { hostWawuId: { in: ALL_SUBS } } });
  }

  async function resetFixtures(): Promise<void> {
    await sweep();

    const base = {
      description: 'A fixture event for the events contract suite.',
      hostOrg: 'Contract Fixtures Ltd',
      format: 'in_person' as const,
      type: 'workshop' as const,
      location: 'Abuja',
    };

    await prisma.event.createMany({
      data: [
        {
          ...base,
          id: EV_PUBLISHED,
          hostWawuId: HOST_SUB,
          name: 'Published, upcoming',
          startsAt: FUTURE,
          status: 'published',
        },
        {
          ...base,
          id: EV_PUBLISHED_PAST,
          hostWawuId: HOST_SUB,
          name: 'Published, already over',
          startsAt: PAST,
          status: 'published',
        },
        {
          ...base,
          id: EV_PENDING,
          hostWawuId: HOST_SUB,
          name: 'Pending, waiting on a human',
          startsAt: FUTURE,
          status: 'pending',
        },
        {
          ...base,
          id: EV_REJECTED,
          hostWawuId: HOST_SUB,
          name: 'Rejected once already',
          startsAt: FUTURE,
          status: 'rejected',
          lastDecisionReason: 'The description was three words long.',
        },
        {
          ...base,
          id: EV_REMOVED,
          hostWawuId: HOST_SUB,
          name: 'Taken down by an admin',
          startsAt: FUTURE,
          status: 'removed',
          lastDecisionReason:
            'Reported by attendees as a different event entirely.',
        },
        {
          ...base,
          id: EV_OTHER_HOST,
          hostWawuId: STRANGER_SUB,
          name: 'Somebody else pending event',
          startsAt: FUTURE,
          status: 'pending',
        },
      ],
    });
  }

  /**
   * The tick columns as this suite found them, restored in afterAll.
   *
   * Hosting is verified-only (build brief B3), so every submission in this
   * suite needs its host to hold a tick. These are SEEDED profile rows shared
   * with other suites, so they are snapshotted and written back rather than
   * left changed - README § Test hygiene, option 2.
   */
  const tickSnapshot = new Map<
    string,
    {
      creatorVerifiedAt: Date | null;
      creatorVerifiedUntil: Date | null;
      professionalVerifiedAt: Date | null;
      professionalVerifiedUntil: Date | null;
    }
  >();

  const TICK_COLUMNS = {
    creatorVerifiedAt: true,
    creatorVerifiedUntil: true,
    professionalVerifiedAt: true,
    professionalVerifiedUntil: true,
  } as const;

  beforeAll(async () => {
    [hostToken, strangerToken, thirdToken] = await Promise.all([
      loginToWawuId(HOST_EMAIL),
      loginToWawuId(STRANGER_EMAIL),
      loginToWawuId(THIRD_EMAIL),
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

    for (const sub of ALL_SUBS) {
      const row = await prisma.userProfile.findUnique({
        where: { wawuUserId: sub },
        select: TICK_COLUMNS,
      });
      if (row) tickSnapshot.set(sub, row);
    }
    // The two accounts that submit here hold a live creator tick. STRANGER_SUB
    // is deliberately left with none: it is the fixture for the refusal.
    await prisma.userProfile.updateMany({
      where: { wawuUserId: { in: [HOST_SUB, THIRD_SUB] } },
      data: {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await prisma.userProfile.updateMany({
      where: { wawuUserId: STRANGER_SUB },
      data: {
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      },
    });
  });

  beforeEach(async () => {
    await resetFixtures();
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

  // ── POST /events ──────────────────────────────────────────────────────────

  describe('POST /api/hub/events', () => {
    it('creates the event as PENDING and on no public read path', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody())
        .expect(201);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.data).toMatchObject({
        name: 'Lagos Makers Workshop',
        hostWawuId: HOST_SUB,
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        // The whole point: a user cannot publish themselves.
        status: 'pending',
        featured: false,
        goingCount: 0,
        userGoing: false,
        hasRecap: false,
      });

      const id = res.body.data.id as string;

      // Not on the public list, for the host or for anyone else.
      for (const token of [hostToken, strangerToken]) {
        const list = await http()
          .get('/api/hub/events')
          .query({ perPage: 100 })
          .set(auth(token))
          .expect(200);
        expect(list.body.data.map((e: { id: string }) => e.id)).not.toContain(
          id,
        );
      }
      // And not readable by anyone but its host.
      await http()
        .get(`/api/hub/events/${id}`)
        .set(auth(strangerToken))
        .expect(404);
      await http()
        .get(`/api/hub/events/${id}`)
        .set(auth(hostToken))
        .expect(200);
    });

    it('is open to any VERIFIED account, whatever kind of account it is', async () => {
      // Holding a tick is the whole of the requirement. There is no upload
      // slot spent here and nobody earns anything, so nothing else gates it.
      const res = await http()
        .post('/api/hub/events')
        .set(auth(thirdToken))
        .send(validEventBody({ name: 'Submitted by a verified account' }))
        .expect(201);
      expect(res.body.data.hostWawuId).toBe(THIRD_SUB);
      expect(res.body.data.status).toBe('pending');
    });

    it('REFUSES an unverified account, and says what would make it eligible', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(strangerToken))
        .send(validEventBody({ name: 'Submitted by an unverified account' }))
        .expect(403);

      // Never a bare 403. The body has to be enough for the app to render a
      // conversion prompt instead of a wall.
      expect(res.body.reason).toBeDefined();
      expect(res.body.reason.code).toBe('verification_required');
      expect(typeof res.body.reason.message).toBe('string');
      expect(res.body.reason.message.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.reason.steps)).toBe(true);
      expect(res.body.reason.steps.length).toBeGreaterThan(0);
      // And the price of the thing it is telling them to buy, in naira.
      expect(res.body.reason.purchasable).toEqual([
        { kind: 'creator', priceNgn: 4999, currency: 'NGN', termMonths: 12 },
      ]);
      // No em-dash anywhere a person reads (CLAUDE.md, product-owner rule).
      const readable = [
        res.body.message,
        res.body.reason.message,
        ...res.body.reason.steps,
      ].join(' ');
      expect(readable).not.toContain('\u2014');

      // And nothing was written.
      const mine = await prisma.event.findMany({
        where: { hostWawuId: STRANGER_SUB, name: 'Submitted by an unverified account' },
      });
      expect(mine).toHaveLength(0);
    });

    it('REFUSES an account whose tick has lapsed, the same as one that never had it', async () => {
      await prisma.userProfile.update({
        where: { wawuUserId: THIRD_SUB },
        data: {
          creatorVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
          creatorVerifiedUntil: new Date('2025-01-01T00:00:00.000Z'),
        },
      });
      try {
        const res = await http()
          .post('/api/hub/events')
          .set(auth(thirdToken))
          .send(validEventBody({ name: 'Submitted on a lapsed tick' }))
          .expect(403);
        expect(res.body.reason.code).toBe('verification_required');
      } finally {
        await prisma.userProfile.update({
          where: { wawuUserId: THIRD_SUB },
          data: {
            creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
            creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
          },
        });
      }
    });

    it('carries the host ticks on the event it returns', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ name: 'Event with a verified host' }))
        .expect(201);
      expect(res.body.data.hostVerification).toEqual({
        creator: { verified: true, expiresAt: '2099-01-01T00:00:00.000Z' },
        professional: { verified: false, expiresAt: null },
      });
    });

    it('stores speakers in order and derives their initials rather than storing them', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          validEventBody({
            speakers: [
              { name: 'Adaeze Okonkwo', title: 'Founder' },
              { name: 'Chidi' },
            ],
          }),
        )
        .expect(201);

      expect(res.body.data.speakers).toEqual([
        {
          name: 'Adaeze Okonkwo',
          title: 'Founder',
          photoUrl: null,
          initials: 'AO',
          order: 0,
        },
        { name: 'Chidi', title: null, photoUrl: null, initials: 'C', order: 1 },
      ]);
    });

    it('stores a speaker photo when one is supplied', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          validEventBody({
            speakers: [
              {
                name: 'Adaeze Okonkwo',
                title: 'Founder',
                photoUrl: 'https://cdn.example.com/event/speaker/adaeze.jpg',
              },
            ],
          }),
        )
        .expect(201);

      expect(res.body.data.speakers).toEqual([
        {
          name: 'Adaeze Okonkwo',
          title: 'Founder',
          photoUrl: 'https://cdn.example.com/event/speaker/adaeze.jpg',
          initials: 'AO',
          order: 0,
        },
      ]);
    });

    // ── THE PRODUCT LINE THAT DOES NOT MOVE ────────────────────────────────
    it('REFUSES any ticketing-shaped field — no price, no amount, no currency, no ticket', async () => {
      // docs/01_SPEC.md cut event TICKETS. Reinstating Events did not reinstate
      // those, and this is where that is enforced: the global ValidationPipe
      // runs with forbidNonWhitelisted and none of these is a declared field,
      // so each one is a 400 before the service is reached.
      for (const money of [
        { price: 5000 },
        { ticketPrice: 5000 },
        { amount: 5000 },
        { currency: 'NGN' },
        { ticketUrl: 'https://tickets.example.com' },
        { capacity: 100 },
      ]) {
        await http()
          .post('/api/hub/events')
          .set(auth(hostToken))
          .send(validEventBody(money))
          .expect(400);
      }

      // And nothing money-shaped exists on the wire shape either.
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody())
        .expect(201);
      for (const key of [
        'price',
        'amount',
        'currency',
        'ticketPrice',
        'cost',
        'credits',
      ]) {
        expect(res.body.data).not.toHaveProperty(key);
      }
    });

    it('400s on missing or blank required fields', async () => {
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send({})
        .expect(400);

      const blank = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ name: '   ' }))
        .expect(400);
      expect(JSON.stringify(blank.body.message)).toContain('name is required.');
    });

    it('400s on an unknown format or type, so a filter chip can never miss an event', async () => {
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ format: 'hybrid' }))
        .expect(400);
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ type: 'conference' }))
        .expect(400);
    });

    it('400s on a non-http(s) externalUrl — this value is rendered as a link', async () => {
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ externalUrl: 'javascript:alert(1)' }))
        .expect(400);
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          validEventBody({ externalUrl: 'https://makers.example.com/lagos' }),
        )
        .expect(201);
    });

    it('400s when endsAt is before startsAt — it would land in neither upcoming nor past', async () => {
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          validEventBody({
            startsAt: FUTURE.toISOString(),
            endsAt: new Date(FUTURE.getTime() - 3_600_000).toISOString(),
          }),
        )
        .expect(400);
    });
  });

  // ── GET /events ───────────────────────────────────────────────────────────

  describe('GET /api/hub/events', () => {
    it('lists PUBLISHED events only — pending, rejected and removed are absent for everyone', async () => {
      const res = await http()
        .get('/api/hub/events')
        .query({ perPage: 100 })
        .set(auth(strangerToken))
        .expect(200);

      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);
      expect(ids).toContain(EV_PUBLISHED);
      expect(ids).not.toContain(EV_PENDING);
      expect(ids).not.toContain(EV_REJECTED);
      expect(ids).not.toContain(EV_REMOVED);
      expect(
        res.body.data.every(
          (e: { status: string }) => e.status === 'published',
        ),
      ).toBe(true);
      expect(res.body.pagination).toMatchObject({
        currentPage: 1,
        perPage: 100,
      });
    });

    it('accepts ?category and filters on it', async () => {
      // The regression this pins: the column, the submit form and the browse
      // chips all shipped, but ListEventsQueryDto had no `category`, so the
      // global forbidNonWhitelisted pipe answered every browse-by-category
      // request with 400 "property category should not exist" before the
      // service ever ran.
      const res = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, category: 'music' })
        .set(auth(strangerToken))
        .expect(200);

      expect(
        res.body.data.every(
          (e: { category: string }) => e.category === 'music',
        ),
      ).toBe(true);
    });

    it('accepts ?host and returns only that host\'s PUBLISHED events', async () => {
      /*
        THE BUG THIS PINS. There was no way to ask for one host's events at
        all, so a creator's profile called GET /events/mine instead - the
        CALLER's events. A visitor opening somebody's profile saw their OWN
        events listed under that person's name.

        /events/mine cannot serve this even filtered: it returns every
        status, including pending and rejected submissions, which belong to
        the host alone. This filters the PUBLIC list, so `status: published`
        still applies. Both halves are asserted below.
      */
      const res = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, host: HOST_SUB })
        .set(auth(strangerToken))
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      expect(
        res.body.data.every(
          (e: { hostWawuId?: string; host?: { wawuId?: string } }) =>
            (e.hostWawuId ?? e.host?.wawuId) === HOST_SUB,
        ),
      ).toBe(true);

      // A host with nothing published comes back empty, not "everybody's".
      const none = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, host: 'nobody-with-this-id' })
        .set(auth(strangerToken))
        .expect(200);
      expect(none.body.data).toEqual([]);
    });

    it('rejects a category that is not one of the enum values', async () => {
      await http()
        .get('/api/hub/events')
        .query({ category: 'not-a-category' })
        .set(auth(strangerToken))
        .expect(400);
    });

    it('combines category with the format and type filters', async () => {
      // Three independent axes: a music event can be online or in person, and
      // a workshop or a summit. One `filter` string could not ask this.
      await http()
        .get('/api/hub/events')
        .query({
          perPage: 100,
          category: 'music',
          format: 'online',
          type: 'workshop',
        })
        .set(auth(strangerToken))
        .expect(200);
    });

    it('defaults to upcoming, and ?view=past returns the other half', async () => {
      const upcoming = await http()
        .get('/api/hub/events')
        .query({ perPage: 100 })
        .set(auth(hostToken))
        .expect(200);
      const upcomingIds: string[] = upcoming.body.data.map(
        (e: { id: string }) => e.id,
      );
      expect(upcomingIds).toContain(EV_PUBLISHED);
      expect(upcomingIds).not.toContain(EV_PUBLISHED_PAST);

      const past = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, view: 'past' })
        .set(auth(hostToken))
        .expect(200);
      const pastIds: string[] = past.body.data.map((e: { id: string }) => e.id);
      expect(pastIds).toContain(EV_PUBLISHED_PAST);
      expect(pastIds).not.toContain(EV_PUBLISHED);
    });

    it('filters by format and by type independently — "online workshops" is one query', async () => {
      await prisma.event.update({
        where: { id: EV_PUBLISHED },
        data: { format: 'online', type: 'webinar' },
      });

      const online = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, format: 'online' })
        .set(auth(hostToken))
        .expect(200);
      expect(online.body.data.map((e: { id: string }) => e.id)).toContain(
        EV_PUBLISHED,
      );

      const inPerson = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, format: 'in_person' })
        .set(auth(hostToken))
        .expect(200);
      expect(inPerson.body.data.map((e: { id: string }) => e.id)).not.toContain(
        EV_PUBLISHED,
      );

      const bothAtOnce = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, format: 'online', type: 'webinar' })
        .set(auth(hostToken))
        .expect(200);
      expect(bothAtOnce.body.data.map((e: { id: string }) => e.id)).toContain(
        EV_PUBLISHED,
      );
    });

    it('400s an undeclared query property and an out-of-range perPage', async () => {
      await http()
        .get('/api/hub/events')
        .query({ filter: 'Workshop' })
        .set(auth(hostToken))
        .expect(400);
      await http()
        .get('/api/hub/events')
        .query({ perPage: 500 })
        .set(auth(hostToken))
        .expect(400);
    });

    it('never leaks the host-only decision reason to anyone else', async () => {
      await prisma.event.update({
        where: { id: EV_PUBLISHED },
        data: {
          lastDecisionReason: 'A private moderator note from an earlier round.',
        },
      });

      const stranger = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(strangerToken))
        .expect(200);
      expect(stranger.body.data.lastDecisionReason).toBeNull();

      const host = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(hostToken))
        .expect(200);
      expect(host.body.data.lastDecisionReason).toBe(
        'A private moderator note from an earlier round.',
      );
    });
  });

  // ── GET /events/mine ──────────────────────────────────────────────────────

  describe('GET /api/hub/events/mine', () => {
    it('shows the host every status they own, and nobody else events', async () => {
      const res = await http()
        .get('/api/hub/events/mine')
        .query({ perPage: 100 })
        .set(auth(hostToken))
        .expect(200);

      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          EV_PUBLISHED,
          EV_PENDING,
          EV_REJECTED,
          EV_REMOVED,
        ]),
      );
      expect(ids).not.toContain(EV_OTHER_HOST);
    });

    it('shows the host WHY it was rejected — this is what stops pending being a dead end', async () => {
      const res = await http()
        .get('/api/hub/events/mine')
        .query({ perPage: 100 })
        .set(auth(hostToken))
        .expect(200);

      const rejected = res.body.data.find(
        (e: { id: string }) => e.id === EV_REJECTED,
      );
      expect(rejected).toMatchObject({
        status: 'rejected',
        lastDecisionReason: 'The description was three words long.',
      });
    });
  });

  // ── GET /events/:id ───────────────────────────────────────────────────────

  describe('GET /api/hub/events/:id', () => {
    it('404s an unknown id and 400s a non-uuid id', async () => {
      const res = await http()
        .get(`/api/hub/events/${UNKNOWN_EVENT}`)
        .set(auth(hostToken))
        .expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Event not found.',
        data: null,
      });
      await http()
        .get('/api/hub/events/not-a-uuid')
        .set(auth(hostToken))
        .expect(400);
    });

    it('404s, not 403s, on somebody else unpublished event — a 403 would confirm the id exists', async () => {
      const res = await http()
        .get(`/api/hub/events/${EV_OTHER_HOST}`)
        .set(auth(hostToken))
        .expect(404);
      expect(res.body.message).toBe('Event not found.');
    });
  });

  // ── PATCH /events/:id ─────────────────────────────────────────────────────

  describe('PATCH /api/hub/events/:id', () => {
    it('sends a PUBLISHED event back to pending — an edit cannot bypass review', async () => {
      const res = await http()
        .patch(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(hostToken))
        .send({ description: 'Rewritten after approval.' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        description: 'Rewritten after approval.',
        status: 'pending',
      });

      // And it leaves the public list immediately.
      const list = await http()
        .get('/api/hub/events')
        .query({ perPage: 100 })
        .set(auth(strangerToken))
        .expect(200);
      expect(list.body.data.map((e: { id: string }) => e.id)).not.toContain(
        EV_PUBLISHED,
      );
    });

    it('is the exit from `rejected`: the host fixes it and it re-enters the queue, reason cleared', async () => {
      const res = await http()
        .patch(`/api/hub/events/${EV_REJECTED}`)
        .set(auth(hostToken))
        .send({
          description: 'A much longer description, addressing the rejection.',
        })
        .expect(200);

      expect(res.body.data.status).toBe('pending');
      // A rejection note still attached to a resubmission tells the host they
      // were rejected for something they have just fixed.
      expect(res.body.data.lastDecisionReason).toBeNull();
    });

    it('keeps the admin pin across a host edit — the host cannot erase a moderator decision', async () => {
      await prisma.event.update({
        where: { id: EV_PUBLISHED },
        data: { featured: true },
      });

      const res = await http()
        .patch(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(hostToken))
        .send({ location: 'Ibadan' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'pending',
        featured: true,
      });
      // Invisible while pending regardless, because the rail filters on status.
      const rail = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, featured: 'true' })
        .set(auth(strangerToken))
        .expect(200);
      expect(rail.body.data.map((e: { id: string }) => e.id)).not.toContain(
        EV_PUBLISHED,
      );
    });

    it('REFUSES to edit a removed event — a takedown is not something a host edits out of', async () => {
      const res = await http()
        .patch(`/api/hub/events/${EV_REMOVED}`)
        .set(auth(hostToken))
        .send({ description: 'Quietly changed into something else.' })
        .expect(403);
      expect(res.body.message).toContain('taken down by an admin');

      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_REMOVED },
      });
      expect(row.status).toBe('removed');
      expect(row.description).toBe(
        'A fixture event for the events contract suite.',
      );
    });

    it('404s somebody else event and changes nothing', async () => {
      await http()
        .patch(`/api/hub/events/${EV_OTHER_HOST}`)
        .set(auth(hostToken))
        .send({ name: 'Hijacked' })
        .expect(404);

      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_OTHER_HOST },
      });
      expect(row.name).toBe('Somebody else pending event');
    });

    it('cannot set featured or status, and cannot smuggle a price in', async () => {
      for (const forbidden of [
        { featured: true },
        { status: 'published' },
        { price: 1000 },
      ]) {
        await http()
          .patch(`/api/hub/events/${EV_PENDING}`)
          .set(auth(hostToken))
          .send(forbidden)
          .expect(400);
      }
      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_PENDING },
      });
      expect(row.status).toBe('pending');
      expect(row.featured).toBe(false);
    });

    it('replaces the speaker list wholesale when one is supplied, and leaves it alone when not', async () => {
      await http()
        .patch(`/api/hub/events/${EV_PENDING}`)
        .set(auth(hostToken))
        .send({ speakers: [{ name: 'Zainab Bello', title: 'Host' }] })
        .expect(200);

      const untouched = await http()
        .patch(`/api/hub/events/${EV_PENDING}`)
        .set(auth(hostToken))
        .send({ location: 'Kano' })
        .expect(200);
      expect(untouched.body.data.speakers).toEqual([
        {
          name: 'Zainab Bello',
          title: 'Host',
          photoUrl: null,
          initials: 'ZB',
          order: 0,
        },
      ]);

      const replaced = await http()
        .patch(`/api/hub/events/${EV_PENDING}`)
        .set(auth(hostToken))
        .send({ speakers: [{ name: 'Chidi Umeh' }] })
        .expect(200);
      expect(replaced.body.data.speakers).toEqual([
        {
          name: 'Chidi Umeh',
          title: null,
          photoUrl: null,
          initials: 'CU',
          order: 0,
        },
      ]);
      expect(
        await prisma.eventSpeaker.count({ where: { eventId: EV_PENDING } }),
      ).toBe(1);
    });

    it('accepts a recap, and hasRecap follows it', async () => {
      const res = await http()
        .patch(`/api/hub/events/${EV_PUBLISHED_PAST}`)
        .set(auth(hostToken))
        .send({ recapText: 'Forty people came. Here is what we covered.' })
        .expect(200);
      expect(res.body.data.hasRecap).toBe(true);
      expect(res.body.data.recapText).toBe(
        'Forty people came. Here is what we covered.',
      );
    });
  });

  // ── the going signal ──────────────────────────────────────────────────────

  describe('POST/DELETE /api/hub/events/:id/going', () => {
    it('is IDEMPOTENT — one person, one signal, however many times they ask', async () => {
      const first = await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(strangerToken))
        .expect(200);
      expect(first.body.data).toEqual({
        eventId: EV_PUBLISHED,
        userGoing: true,
        goingCount: 1,
      });

      // A retried request is the same signal, not a second one and not a toggle.
      for (let i = 0; i < 3; i++) {
        const again = await http()
          .post(`/api/hub/events/${EV_PUBLISHED}/going`)
          .set(auth(strangerToken))
          .expect(200);
        expect(again.body.data).toEqual({
          eventId: EV_PUBLISHED,
          userGoing: true,
          goingCount: 1,
        });
      }

      expect(
        await prisma.eventGoing.count({
          where: { eventId: EV_PUBLISHED, userWawuId: STRANGER_SUB },
        }),
      ).toBe(1);
    });

    it('counts each person once and shows the caller their own state', async () => {
      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(strangerToken))
        .expect(200);
      const second = await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(thirdToken))
        .expect(200);
      expect(second.body.data.goingCount).toBe(2);

      const seenByGoer = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(strangerToken))
        .expect(200);
      expect(seenByGoer.body.data).toMatchObject({
        goingCount: 2,
        userGoing: true,
      });

      const seenByHost = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(hostToken))
        .expect(200);
      expect(seenByHost.body.data).toMatchObject({
        goingCount: 2,
        userGoing: false,
      });
    });

    it('is WITHDRAWABLE, and withdrawing is idempotent too', async () => {
      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(strangerToken))
        .expect(200);

      const gone = await http()
        .delete(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(strangerToken))
        .expect(200);
      expect(gone.body.data).toEqual({
        eventId: EV_PUBLISHED,
        userGoing: false,
        goingCount: 0,
      });

      // Withdrawing again is a 200 describing the true state, not a 404: the
      // client's job is to end up correct, not to have guessed right first.
      const again = await http()
        .delete(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(strangerToken))
        .expect(200);
      expect(again.body.data).toEqual({
        eventId: EV_PUBLISHED,
        userGoing: false,
        goingCount: 0,
      });
      expect(
        await prisma.eventGoing.count({ where: { eventId: EV_PUBLISHED } }),
      ).toBe(0);
    });

    it('costs nothing — no purchase, no credit spend, no charge of any kind is written', async () => {
      const before = await Promise.all([
        prisma.purchase.count({ where: { buyerWawuId: STRANGER_SUB } }),
        prisma.creditSpend.count({ where: { userWawuId: STRANGER_SUB } }),
      ]);

      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(strangerToken))
        .expect(200);

      const after = await Promise.all([
        prisma.purchase.count({ where: { buyerWawuId: STRANGER_SUB } }),
        prisma.creditSpend.count({ where: { userWawuId: STRANGER_SUB } }),
      ]);
      expect(after).toEqual(before);
    });

    it('refuses a signal on an event that is not published yet', async () => {
      // The host can SEE their own pending event, so they get a plain-language
      // 400 rather than the 404 a stranger gets for the same id.
      const res = await http()
        .post(`/api/hub/events/${EV_PENDING}/going`)
        .set(auth(hostToken))
        .expect(400);
      expect(res.body.message).toBe('This event is not published yet.');

      await http()
        .post(`/api/hub/events/${EV_PENDING}/going`)
        .set(auth(strangerToken))
        .expect(404);
      expect(
        await prisma.eventGoing.count({ where: { eventId: EV_PENDING } }),
      ).toBe(0);
    });

    it('404s an unknown event', async () => {
      await http()
        .post(`/api/hub/events/${UNKNOWN_EVENT}/going`)
        .set(auth(hostToken))
        .expect(404);
      await http()
        .delete(`/api/hub/events/${UNKNOWN_EVENT}/going`)
        .set(auth(hostToken))
        .expect(404);
    });
  });

  // ── what the approved Events screen draws ─────────────────────────────────

  describe('the fields the Events screen renders', () => {
    it('carries the venue by name, separately from the city', async () => {
      const res = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(
          validEventBody({
            location: 'Lagos',
            venueName: 'Eko Convention Centre',
          }),
        )
        .expect(201);

      // Two facts, two fields. The card prints the city, the hero prints the
      // venue under a pin, and before this column one string had to be both.
      expect(res.body.data.location).toBe('Lagos');
      expect(res.body.data.venueName).toBe('Eko Convention Centre');
    });

    it('reports a null venue rather than omitting it, on an event that has none', async () => {
      const res = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(hostToken))
        .expect(200);

      // Every fixture here predates the column. The field must still be
      // present and null: a client that falls back to `location` has to be
      // able to tell "no venue" from "field missing".
      expect(res.body.data).toHaveProperty('venueName', null);
    });

    it('lets a host blank the venue with an empty string', async () => {
      const created = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ venueName: 'Freedom Park' }))
        .expect(201);

      const res = await http()
        .patch(`/api/hub/events/${created.body.data.id}`)
        .set(auth(hostToken))
        .send({ venueName: '   ' })
        .expect(200);
      expect(res.body.data.venueName).toBeNull();
    });

    it('derives the "from" price from the cheapest ticket tier, and never stores one', async () => {
      await prisma.eventTicketType.createMany({
        data: [
          {
            eventId: EV_PUBLISHED,
            tier: 'vip',
            name: 'VIP',
            priceNaira: 25000,
            quantity: 20,
          },
          {
            eventId: EV_PUBLISHED,
            tier: 'regular',
            name: 'Regular',
            priceNaira: 10000,
            quantity: 200,
          },
        ],
      });

      const res = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(strangerToken))
        .expect(200);

      expect(res.body.data.ticketed).toBe(true);
      expect(res.body.data.priceFromNaira).toBe(10000);
    });

    it('reports an unticketed event as null, never as ₦0', async () => {
      const res = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(strangerToken))
        .expect(200);

      // Free and not-for-sale are different things, and only one of them is
      // an invitation to pay. A 0 here would print "₦0" on the card.
      expect(res.body.data.ticketed).toBe(false);
      expect(res.body.data.priceFromNaira).toBeNull();
    });

    it('refuses a price on the event itself — tickets are their own resource', async () => {
      await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send(validEventBody({ priceNaira: 5000 }))
        .expect(400);
    });
  });

  // ── the bookmark ──────────────────────────────────────────────────────────

  describe('POST/DELETE /api/hub/events/:id/save', () => {
    it('saves, reports the state back, and is idempotent', async () => {
      const first = await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/save`)
        .set(auth(strangerToken))
        .expect(200);
      expect(first.body.data).toEqual({
        eventId: EV_PUBLISHED,
        userSaved: true,
      });

      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/save`)
        .set(auth(strangerToken))
        .expect(200);

      // One row, not two: the unique key is the idempotency.
      expect(
        await prisma.eventSave.count({ where: { eventId: EV_PUBLISHED } }),
      ).toBe(1);
    });

    it('removes it, and removing one that was never there is still a 200', async () => {
      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/save`)
        .set(auth(strangerToken))
        .expect(200);

      const res = await http()
        .delete(`/api/hub/events/${EV_PUBLISHED}/save`)
        .set(auth(strangerToken))
        .expect(200);
      expect(res.body.data).toEqual({
        eventId: EV_PUBLISHED,
        userSaved: false,
      });

      await http()
        .delete(`/api/hub/events/${EV_PUBLISHED}/save`)
        .set(auth(strangerToken))
        .expect(200);
      expect(
        await prisma.eventSave.count({ where: { eventId: EV_PUBLISHED } }),
      ).toBe(0);
    });

    it('is per viewer, and is not the same statement as "Going"', async () => {
      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/save`)
        .set(auth(strangerToken))
        .expect(200);

      const mine = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(strangerToken))
        .expect(200);
      expect(mine.body.data.userSaved).toBe(true);
      // Saving it told the organiser nothing.
      expect(mine.body.data.userGoing).toBe(false);
      expect(mine.body.data.goingCount).toBe(0);

      const theirs = await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(thirdToken))
        .expect(200);
      expect(theirs.body.data.userSaved).toBe(false);
    });

    it('404s an unknown event, and a stranger\'s unpublished one', async () => {
      await http()
        .post(`/api/hub/events/${UNKNOWN_EVENT}/save`)
        .set(auth(hostToken))
        .expect(404);
      await http()
        .post(`/api/hub/events/${EV_PENDING}/save`)
        .set(auth(strangerToken))
        .expect(404);
    });
  });

  // ── the two rails ─────────────────────────────────────────────────────────

  describe('GET /api/hub/events?sort=trending', () => {
    it('orders by interest, and leaves the default order alone', async () => {
      // EV_PUBLISHED starts in 2027; add a later one and give it the interest.
      const later = await prisma.event.create({
        data: {
          id: 'ee000000-0000-4000-8000-0000000000aa',
          hostWawuId: HOST_SUB,
          name: 'Later, but everybody is going',
          description: 'A fixture event for the events contract suite.',
          hostOrg: 'Contract Fixtures Ltd',
          format: 'in_person',
          type: 'workshop',
          location: 'Abuja',
          startsAt: new Date('2027-09-04T09:00:00.000Z'),
          status: 'published',
        },
      });
      await prisma.eventGoing.createMany({
        data: ALL_SUBS.map((sub) => ({ eventId: later.id, userWawuId: sub })),
      });

      const trending = await http()
        .get('/api/hub/events?sort=trending')
        .set(auth(hostToken))
        .expect(200);
      expect((trending.body.data as { id: string }[])[0].id).toBe(later.id);

      // No sort parameter is still "the row nearest to today first".
      const calendar = await http()
        .get('/api/hub/events')
        .set(auth(hostToken))
        .expect(200);
      expect((calendar.body.data as { id: string }[])[0].id).toBe(EV_PUBLISHED);
    });

    it('400s a sort nobody implements, rather than silently ignoring it', async () => {
      await http()
        .get('/api/hub/events?sort=whatever')
        .set(auth(hostToken))
        .expect(400);
    });
  });

  // ── auth ──────────────────────────────────────────────────────────────────

  describe('who may reach this surface', () => {
    it('refuses an unauthenticated request on every route', async () => {
      await http().get('/api/hub/events').expect(401);
      await http().get('/api/hub/events/mine').expect(401);
      await http().get(`/api/hub/events/${EV_PUBLISHED}`).expect(401);
      await http().post('/api/hub/events').send(validEventBody()).expect(401);
      await http()
        .patch(`/api/hub/events/${EV_PUBLISHED}`)
        .send({ name: 'x' })
        .expect(401);
      await http().post(`/api/hub/events/${EV_PUBLISHED}/going`).expect(401);
      await http().delete(`/api/hub/events/${EV_PUBLISHED}/going`).expect(401);
      await http().post(`/api/hub/events/${EV_PUBLISHED}/save`).expect(401);
      await http().delete(`/api/hub/events/${EV_PUBLISHED}/save`).expect(401);
    });
  });
});
