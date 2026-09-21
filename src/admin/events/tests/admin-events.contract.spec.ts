import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { EventModule } from '../../../event/event.module';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminEventsModule } from '../admin-events.module';

/**
 * Contract tests for admin event moderation, reinstated 22 Aug 2026 by
 * product-owner decision.
 *
 * The load-bearing assertion in this file is not that a column changed. It is
 * that a user creates an event through the REAL app endpoint, that event is
 * invisible on the REAL public list, an admin approves it, and the same
 * unmodified app endpoint with the same user token then returns it. Both the
 * app half (EventModule) and the admin half are mounted from their real
 * modules; nothing is stubbed.
 *
 * Also proved here: the queue lists only pending work; a rejection and a
 * takedown are both refused without a reason; the reason reaches the HOST on
 * their own endpoint; feature and unfeature; a takedown clears the pin and
 * pulls the event off the public list; restore brings it back (so a takedown
 * is not a one-way door); every decision writes an audit row naming who, when
 * and why; a non-reviewer admin role is refused; and a WAWU ID user token
 * cannot reach any of it.
 *
 * Fixtures live under this suite's own `ea……` / `ad……` id prefixes and are
 * swept in afterAll (README § Test hygiene). No seeded row is mutated.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded plain WAWU ID users. The mock keys login on the identifier, not the sub. */
const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER_SUB = '00000000-0000-4000-8000-000000000002';
const ALL_SUBS = [HOST_SUB, OTHER_SUB];

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'ad000000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'ad000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'ad000000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'ad000000-0000-4000-8000-000000000004';
const ADMIN_IDS = [
  ADMIN_SUPER_ID,
  ADMIN_REVIEWER_ID,
  ADMIN_SUPPORT_ID,
  ADMIN_FINANCE_ID,
];

const SUPER_EMAIL = 'events-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'events-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'events-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'events-finance@admin.test.wawu.dev';
const PASSWORD = 'admin-events-contract-password';

const TEST_ACCESS_SECRET = 'admin-events-access-secret-0123456789abcdef';
const TEST_REFRESH_SECRET = 'admin-events-refresh-secret-0123456789abcdef';

// ── suite-owned event fixtures ──────────────────────────────────────────────
const EV_PENDING_OLD = 'ea000000-0000-4000-8000-000000000001';
const EV_PENDING_NEW = 'ea000000-0000-4000-8000-000000000002';
const EV_PUBLISHED = 'ea000000-0000-4000-8000-000000000003';
const EV_REJECTED = 'ea000000-0000-4000-8000-000000000004';
const EV_REMOVED = 'ea000000-0000-4000-8000-000000000005';
const FIXTURE_IDS = [
  EV_PENDING_OLD,
  EV_PENDING_NEW,
  EV_PUBLISHED,
  EV_REJECTED,
  EV_REMOVED,
];
const UNKNOWN_EVENT = 'ea000000-0000-4000-8000-0000000000ff';

const FUTURE = new Date('2027-05-06T09:00:00.000Z');

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

describe('Admin events moderation contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superToken: string;
  let reviewerToken: string;
  let supportToken: string;
  let financeToken: string;
  let hostToken: string;
  /** The host's tick columns as this suite found them. See beforeAll. */
  let hostTickSnapshot: {
    creatorVerifiedAt: Date | null;
    creatorVerifiedUntil: Date | null;
    professionalVerifiedAt: Date | null;
    professionalVerifiedUntil: Date | null;
  } | null = null;
  let otherUserToken: string;

  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function sweepEvents(): Promise<void> {
    await prisma.adminEventReview.deleteMany({
      where: { hostWawuId: { in: ALL_SUBS } },
    });
    await prisma.adminEventReview.deleteMany({
      where: { eventId: { in: FIXTURE_IDS } },
    });
    // EventSpeaker and EventGoing cascade from Event.
    await prisma.event.deleteMany({ where: { hostWawuId: { in: ALL_SUBS } } });
  }

  async function resetFixtures(): Promise<void> {
    await sweepEvents();

    const base = {
      hostWawuId: HOST_SUB,
      description: 'A fixture event for the admin events contract suite.',
      hostOrg: 'Contract Fixtures Ltd',
      format: 'in_person' as const,
      type: 'workshop' as const,
      location: 'Port Harcourt',
      startsAt: FUTURE,
    };

    await prisma.event.createMany({
      data: [
        {
          ...base,
          id: EV_PENDING_OLD,
          name: 'Pending, waiting longest',
          status: 'pending',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          ...base,
          id: EV_PENDING_NEW,
          name: 'Pending, just arrived',
          status: 'pending',
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          ...base,
          id: EV_PUBLISHED,
          name: 'Already published',
          status: 'published',
        },
        {
          ...base,
          id: EV_REJECTED,
          name: 'Already rejected',
          status: 'rejected',
        },
        {
          ...base,
          id: EV_REMOVED,
          name: 'Already taken down',
          status: 'removed',
        },
      ],
    });
  }

  /** Ids on the app-facing public list, as an ordinary signed-in user sees it. */
  async function publicListIds(token = otherUserToken): Promise<string[]> {
    const res = await http()
      .get('/api/hub/events')
      .query({ perPage: 100 })
      .set(auth(token))
      .expect(200);
    return res.body.data.map((e: { id: string }) => e.id);
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    [hostToken, otherUserToken] = await Promise.all([
      loginToWawuId(HOST_EMAIL),
      loginToWawuId(OTHER_EMAIL),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminEventsModule,
        // The REAL app-facing surface, unmodified, so "approved" can be proved
        // against what a user actually calls rather than against a column.
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

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        {
          id: ADMIN_SUPER_ID,
          email: SUPER_EMAIL,
          name: 'Events Super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: ADMIN_REVIEWER_ID,
          email: REVIEWER_EMAIL,
          name: 'Events Reviewer',
          role: 'reviewer',
          passwordHash,
        },
        {
          id: ADMIN_SUPPORT_ID,
          email: SUPPORT_EMAIL,
          name: 'Events Support',
          role: 'support',
          passwordHash,
        },
        {
          id: ADMIN_FINANCE_ID,
          email: FINANCE_EMAIL,
          name: 'Events Finance',
          role: 'finance',
          passwordHash,
        },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);

    // Hosting is verified-only (build brief B3), and this suite submits
    // through the REAL app endpoint on purpose, so its host needs a live
    // tick. The seeded row is snapshotted and written back in afterAll
    // rather than left changed (README § Test hygiene, option 2).
    hostTickSnapshot = await prisma.userProfile.findUnique({
      where: { wawuUserId: HOST_SUB },
      select: {
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
        professionalVerifiedAt: true,
        professionalVerifiedUntil: true,
      },
    });
    await prisma.userProfile.updateMany({
      where: { wawuUserId: HOST_SUB },
      data: {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  });

  beforeEach(async () => {
    await resetFixtures();
  });

  afterAll(async () => {
    await sweepEvents();
    if (hostTickSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: hostTickSnapshot,
      });
    }
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── the whole point of the module ─────────────────────────────────────────

  describe('a user submits, an admin decides, the public sees the result', () => {
    it('a user-created event is NOT publicly visible, and IS after an admin approves it', async () => {
      // 1. A real user, through the real app endpoint.
      const created = await http()
        .post('/api/hub/events')
        .set(auth(hostToken))
        .send({
          name: 'Aba Fabric Sourcing Meetup',
          description: 'Where to buy, what to pay, who to trust.',
          hostOrg: 'Aba Textile Circle',
          format: 'in_person',
          type: 'meetup',
          startsAt: FUTURE.toISOString(),
          location: 'Aba',
        })
        .expect(201);
      const id = created.body.data.id as string;
      expect(created.body.data.status).toBe('pending');

      // 2. Invisible to everyone else on the real public list, and by id.
      expect(await publicListIds()).not.toContain(id);
      await http()
        .get(`/api/hub/events/${id}`)
        .set(auth(otherUserToken))
        .expect(404);

      // 3. An admin approves.
      const decided = await http()
        .post(`/api/hub/admin/events/${id}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(decided.body.data.event.status).toBe('published');

      // 4. The SAME unmodified app endpoint, the SAME user token, now 200.
      expect(await publicListIds()).toContain(id);
      const seen = await http()
        .get(`/api/hub/events/${id}`)
        .set(auth(otherUserToken))
        .expect(200);
      expect(seen.body.data).toMatchObject({
        id,
        status: 'published',
        name: 'Aba Fabric Sourcing Meetup',
      });
    });

    it('a rejection keeps the event off the public list and tells the HOST why, on their own endpoint', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({
          reason: 'The address is a residential flat with no venue name.',
        })
        .expect(200);

      expect(await publicListIds()).not.toContain(EV_PENDING_OLD);

      const mine = await http()
        .get('/api/hub/events/mine')
        .query({ perPage: 100 })
        .set(auth(hostToken))
        .expect(200);
      const row = mine.body.data.find(
        (e: { id: string }) => e.id === EV_PENDING_OLD,
      );
      expect(row).toMatchObject({
        status: 'rejected',
        lastDecisionReason:
          'The address is a residential flat with no venue name.',
      });
    });

    it('the host can edit a rejected event back into the queue — rejected is not a dead end', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Needs a venue name.' })
        .expect(200);

      const resubmitted = await http()
        .patch(`/api/hub/events/${EV_PENDING_OLD}`)
        .set(auth(hostToken))
        .send({ address: 'Alpha Hall, 14 Ikwerre Road' })
        .expect(200);
      expect(resubmitted.body.data.status).toBe('pending');

      // And it is back in the admin queue, so a human will see it again.
      const queue = await http()
        .get('/api/hub/admin/events/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);
      expect(queue.body.data.map((e: { id: string }) => e.id)).toContain(
        EV_PENDING_OLD,
      );
    });
  });

  // ── GET /admin/events/queue ───────────────────────────────────────────────

  describe('GET /api/hub/admin/events/queue', () => {
    it('lists ONLY pending events, oldest first, in the standard envelope', async () => {
      const res = await http()
        .get('/api/hub/admin/events/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.pagination).toMatchObject({
        currentPage: 1,
        perPage: 100,
      });

      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);
      expect(ids).toContain(EV_PENDING_OLD);
      expect(ids).toContain(EV_PENDING_NEW);
      expect(ids).not.toContain(EV_PUBLISHED);
      expect(ids).not.toContain(EV_REJECTED);
      expect(ids).not.toContain(EV_REMOVED);
      expect(
        res.body.data.every((e: { status: string }) => e.status === 'pending'),
      ).toBe(true);

      // Oldest first is the default and the whole point of a review queue.
      expect(ids.indexOf(EV_PENDING_OLD)).toBeLessThan(
        ids.indexOf(EV_PENDING_NEW),
      );
    });

    it('honours ?sort=newest', async () => {
      const res = await http()
        .get('/api/hub/admin/events/queue')
        .query({ perPage: 100, sort: 'newest' })
        .set(auth(reviewerToken))
        .expect(200);
      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);
      expect(ids.indexOf(EV_PENDING_NEW)).toBeLessThan(
        ids.indexOf(EV_PENDING_OLD),
      );
    });

    it('carries the host block and the waiting time a reviewer triages on', async () => {
      const res = await http()
        .get('/api/hub/admin/events/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const item = res.body.data.find(
        (e: { id: string }) => e.id === EV_PENDING_OLD,
      );
      expect(item).toMatchObject({
        name: 'Pending, waiting longest',
        hostOrg: 'Contract Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Port Harcourt',
        status: 'pending',
        featured: false,
        goingCount: 0,
      });
      expect(item.waitingHours).toBeGreaterThan(0);
      // A host with no UserProfile is not an error and is not hidden — the
      // event still has to be reviewed. Every field is null rather than an
      // invented default, so the dashboard shows "unknown".
      expect(item.host).toMatchObject({ wawuUserId: HOST_SUB });
      expect(item.host).toHaveProperty('handle');
      expect(item.host).toHaveProperty('accountType');
    });

    it('never exposes a money field — events take no money in this product', async () => {
      const res = await http()
        .get('/api/hub/admin/events/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);
      for (const item of res.body.data) {
        for (const key of [
          'price',
          'amount',
          'currency',
          'ticketPrice',
          'revenue',
          'credits',
        ]) {
          expect(item).not.toHaveProperty(key);
        }
      }
    });

    it('400s on an undeclared query property and an out-of-range perPage', async () => {
      await http()
        .get('/api/hub/admin/events/queue')
        .query({ status: 'published' })
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .get('/api/hub/admin/events/queue')
        .query({ perPage: 500 })
        .set(auth(reviewerToken))
        .expect(400);
    });
  });

  // ── GET /admin/events (the all-statuses browse) ───────────────────────────

  describe('GET /api/hub/admin/events', () => {
    it('reaches every status, which is the only way to find a PUBLISHED event to feature or take down', async () => {
      const res = await http()
        .get('/api/hub/admin/events')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);
      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);
      for (const id of FIXTURE_IDS) expect(ids).toContain(id);
    });

    it('narrows with ?status=', async () => {
      const res = await http()
        .get('/api/hub/admin/events')
        .query({ perPage: 100, status: 'removed' })
        .set(auth(reviewerToken))
        .expect(200);
      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);
      expect(ids).toContain(EV_REMOVED);
      expect(ids).not.toContain(EV_PUBLISHED);
      expect(
        res.body.data.every((e: { status: string }) => e.status === 'removed'),
      ).toBe(true);
    });

    it('400s an unknown status', async () => {
      await http()
        .get('/api/hub/admin/events')
        .query({ status: 'draft' })
        .set(auth(reviewerToken))
        .expect(400);
    });
  });

  // ── GET /admin/events/:id ─────────────────────────────────────────────────

  describe('GET /api/hub/admin/events/:id', () => {
    it('returns full detail at any status, with an empty history until it is moderated', async () => {
      const res = await http()
        .get(`/api/hub/admin/events/${EV_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(res.body.data).toMatchObject({
        id: EV_PENDING_OLD,
        status: 'pending',
      });
      expect(res.body.data.reviewHistory).toEqual([]);

      for (const id of [EV_PUBLISHED, EV_REJECTED, EV_REMOVED]) {
        await http()
          .get(`/api/hub/admin/events/${id}`)
          .set(auth(reviewerToken))
          .expect(200);
      }
    });

    it('404s an unknown id and 400s a non-uuid id', async () => {
      const res = await http()
        .get(`/api/hub/admin/events/${UNKNOWN_EVENT}`)
        .set(auth(reviewerToken))
        .expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Event not found.',
        data: null,
      });
      await http()
        .get('/api/hub/admin/events/not-a-uuid')
        .set(auth(reviewerToken))
        .expect(400);
    });
  });

  // ── approve ───────────────────────────────────────────────────────────────

  describe('POST /api/hub/admin/events/:id/approve', () => {
    it('writes an audit row naming who approved it, when, and from which status', async () => {
      const res = await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(superToken))
        .expect(200);

      expect(res.body.data.review).toMatchObject({
        action: 'approved',
        previousStatus: 'pending',
        newStatus: 'published',
        previousFeatured: false,
        newFeatured: false,
        reason: null,
        reviewedByAdminId: ADMIN_SUPER_ID,
        reviewedByAdminEmail: SUPER_EMAIL,
        reviewedByAdminRole: 'superadmin',
      });

      const rows = await prisma.adminEventReview.findMany({
        where: { eventId: EV_PENDING_OLD },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        hostWawuId: HOST_SUB,
        action: 'approved',
      });
      expect(rows[0].reviewedAt).toBeInstanceOf(Date);

      const detail = await http()
        .get(`/api/hub/admin/events/${EV_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(detail.body.data.reviewHistory).toHaveLength(1);
      expect(detail.body.data.reviewHistory[0].reviewedByAdminEmail).toBe(
        SUPER_EMAIL,
      );
    });

    it('400s on an event that is not pending, and writes no audit row', async () => {
      const res = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/approve`)
        .set(auth(reviewerToken))
        .expect(400);
      expect(res.body.message).toBe(
        'An event can only be approved from pending — this one is published.',
      );
      expect(
        await prisma.adminEventReview.count({
          where: { eventId: EV_PUBLISHED },
        }),
      ).toBe(0);
    });

    it('refuses a second decision on the same event — one decision, one audit row', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Changed my mind.' })
        .expect(400);
      expect(
        await prisma.adminEventReview.count({
          where: { eventId: EV_PENDING_OLD },
        }),
      ).toBe(1);
    });

    it('404s an unknown id', async () => {
      await http()
        .post(`/api/hub/admin/events/${UNKNOWN_EVENT}/approve`)
        .set(auth(reviewerToken))
        .expect(404);
    });
  });

  // ── reject ────────────────────────────────────────────────────────────────

  describe('POST /api/hub/admin/events/:id/reject', () => {
    it('REQUIRES a reason, and writes nothing without one', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({})
        .expect(400);

      // A single space is not a reason.
      const res = await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: '   ' })
        .expect(400);
      expect(res.body.message).toBe(
        'reason is required — the host is shown it.',
      );

      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_PENDING_OLD },
      });
      expect(row.status).toBe('pending');
      expect(row.lastDecisionReason).toBeNull();
      expect(
        await prisma.adminEventReview.count({
          where: { eventId: EV_PENDING_OLD },
        }),
      ).toBe(0);
    });

    it('400s a reason longer than 1000 characters', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'x'.repeat(1001) })
        .expect(400);
    });

    it('records the reason on the audit row AND on the event the host reads', async () => {
      const res = await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Duplicate of an event already on the calendar.' })
        .expect(200);

      expect(res.body.data.event.status).toBe('rejected');
      expect(res.body.data.review).toMatchObject({
        action: 'rejected',
        previousStatus: 'pending',
        newStatus: 'rejected',
        reason: 'Duplicate of an event already on the calendar.',
        reviewedByAdminEmail: REVIEWER_EMAIL,
      });

      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_PENDING_OLD },
      });
      expect(row.lastDecisionReason).toBe(
        'Duplicate of an event already on the calendar.',
      );
    });
  });

  // ── feature / unfeature ───────────────────────────────────────────────────

  describe('POST /api/hub/admin/events/:id/feature and /unfeature', () => {
    it('pins a published event onto the featured rail, and unpins it again', async () => {
      const pinned = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(pinned.body.data.event.featured).toBe(true);
      expect(pinned.body.data.review).toMatchObject({
        action: 'featured',
        previousStatus: 'published',
        newStatus: 'published',
        previousFeatured: false,
        newFeatured: true,
      });

      const rail = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, featured: 'true' })
        .set(auth(otherUserToken))
        .expect(200);
      expect(rail.body.data.map((e: { id: string }) => e.id)).toEqual([
        EV_PUBLISHED,
      ]);

      const unpinned = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/unfeature`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(unpinned.body.data.event.featured).toBe(false);
      expect(unpinned.body.data.review).toMatchObject({
        action: 'unfeatured',
        previousFeatured: true,
        newFeatured: false,
      });

      const emptyRail = await http()
        .get('/api/hub/events')
        .query({ perPage: 100, featured: 'true' })
        .set(auth(otherUserToken))
        .expect(200);
      expect(
        emptyRail.body.data.map((e: { id: string }) => e.id),
      ).not.toContain(EV_PUBLISHED);
    });

    it('refuses to feature anything the public cannot open — a rail pointing at a 404', async () => {
      for (const id of [EV_PENDING_OLD, EV_REJECTED, EV_REMOVED]) {
        const res = await http()
          .post(`/api/hub/admin/events/${id}/feature`)
          .set(auth(reviewerToken))
          .expect(400);
        expect(res.body.message).toContain(
          'can only be featured from published',
        );
      }
      expect(
        await prisma.adminEventReview.count({
          where: { eventId: EV_PENDING_OLD },
        }),
      ).toBe(0);
    });

    it('refuses a no-op in either direction, so no audit row claims a change that did not happen', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(reviewerToken))
        .expect(200);
      const again = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(reviewerToken))
        .expect(400);
      expect(again.body.message).toBe('This event is already featured.');

      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/unfeature`)
        .set(auth(reviewerToken))
        .expect(200);
      const alreadyOff = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/unfeature`)
        .set(auth(reviewerToken))
        .expect(400);
      expect(alreadyOff.body.message).toBe('This event is not featured.');

      expect(
        await prisma.adminEventReview.count({
          where: { eventId: EV_PUBLISHED },
        }),
      ).toBe(2);
    });

    it('can unfeature at any status, so a pin is never stranded on an event a host has since edited', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(reviewerToken))
        .expect(200);

      // The host edits it, which sends it back to pending with the pin intact.
      await http()
        .patch(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(hostToken))
        .send({ location: 'Uyo' })
        .expect(200);

      const res = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/unfeature`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(res.body.data.event).toMatchObject({
        featured: false,
        status: 'pending',
      });
    });
  });

  // ── takedown / restore ────────────────────────────────────────────────────

  describe('POST /api/hub/admin/events/:id/remove and /restore', () => {
    it('REQUIRES a reason to take a published event down', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .set(auth(reviewerToken))
        .send({})
        .expect(400);
      const res = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .set(auth(reviewerToken))
        .send({ reason: ' ' })
        .expect(400);
      expect(res.body.message).toBe(
        'reason is required — the host is shown it.',
      );

      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_PUBLISHED },
      });
      expect(row.status).toBe('published');
    });

    it('pulls it off the public list, clears the pin, and tells the host why', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(await publicListIds()).toContain(EV_PUBLISHED);

      const res = await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .set(auth(reviewerToken))
        .send({ reason: 'The venue confirmed this event is not happening.' })
        .expect(200);

      expect(res.body.data.event).toMatchObject({
        status: 'removed',
        featured: false,
      });
      expect(res.body.data.review).toMatchObject({
        action: 'removed',
        previousStatus: 'published',
        newStatus: 'removed',
        previousFeatured: true,
        newFeatured: false,
        reason: 'The venue confirmed this event is not happening.',
      });

      expect(await publicListIds()).not.toContain(EV_PUBLISHED);
      await http()
        .get(`/api/hub/events/${EV_PUBLISHED}`)
        .set(auth(otherUserToken))
        .expect(404);

      const mine = await http()
        .get('/api/hub/events/mine')
        .query({ perPage: 100 })
        .set(auth(hostToken))
        .expect(200);
      expect(
        mine.body.data.find((e: { id: string }) => e.id === EV_PUBLISHED),
      ).toMatchObject({
        status: 'removed',
        lastDecisionReason: 'The venue confirmed this event is not happening.',
      });
    });

    it('refunds nobody, because nobody paid — the going signals survive the takedown', async () => {
      await http()
        .post(`/api/hub/events/${EV_PUBLISHED}/going`)
        .set(auth(otherUserToken))
        .expect(200);

      const purchasesBefore = await prisma.purchase.count({
        where: { buyerWawuId: OTHER_SUB },
      });

      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .set(auth(reviewerToken))
        .send({ reason: 'Cancelled by the organiser.' })
        .expect(200);

      // No money moved because none ever had. And the record of who was
      // interested is not destroyed — it is the only evidence of what the
      // takedown affected.
      expect(
        await prisma.purchase.count({ where: { buyerWawuId: OTHER_SUB } }),
      ).toBe(purchasesBefore);
      expect(
        await prisma.eventGoing.count({ where: { eventId: EV_PUBLISHED } }),
      ).toBe(1);
    });

    it('refuses to take down anything that was never published', async () => {
      for (const id of [EV_PENDING_OLD, EV_REJECTED, EV_REMOVED]) {
        await http()
          .post(`/api/hub/admin/events/${id}/remove`)
          .set(auth(reviewerToken))
          .send({ reason: 'Not applicable.' })
          .expect(400);
      }
    });

    it('restores a removed event — a takedown is not a one-way door', async () => {
      const res = await http()
        .post(`/api/hub/admin/events/${EV_REMOVED}/restore`)
        .set(auth(superToken))
        .expect(200);
      expect(res.body.data.event.status).toBe('published');
      expect(res.body.data.review).toMatchObject({
        action: 'restored',
        previousStatus: 'removed',
        newStatus: 'published',
      });
      expect(await publicListIds()).toContain(EV_REMOVED);
    });

    it('refuses to restore anything that was not removed', async () => {
      for (const id of [EV_PENDING_OLD, EV_PUBLISHED, EV_REJECTED]) {
        await http()
          .post(`/api/hub/admin/events/${id}/restore`)
          .set(auth(reviewerToken))
          .expect(400);
      }
    });

    it('the host cannot edit their way out of a takedown', async () => {
      const res = await http()
        .patch(`/api/hub/events/${EV_REMOVED}`)
        .set(auth(hostToken))
        .send({ name: 'Renamed to dodge the takedown' })
        .expect(403);
      expect(res.body.message).toContain('taken down by an admin');
    });
  });

  // ── auth + role matrix ────────────────────────────────────────────────────

  describe('who may reach this surface', () => {
    it('refuses an unauthenticated request on every route', async () => {
      await http().get('/api/hub/admin/events').expect(401);
      await http().get('/api/hub/admin/events/queue').expect(401);
      await http().get(`/api/hub/admin/events/${EV_PENDING_OLD}`).expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .send({ reason: 'nope' })
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/unfeature`)
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .send({ reason: 'nope' })
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_REMOVED}/restore`)
        .expect(401);
    });

    it('refuses a valid WAWU ID USER token — an app user cannot moderate, not even their own event', async () => {
      await http()
        .get('/api/hub/admin/events/queue')
        .set(auth(hostToken))
        .expect(401);
      await http()
        .get('/api/hub/admin/events')
        .set(auth(hostToken))
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(hostToken))
        .expect(401);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(hostToken))
        .expect(401);

      // The host owns EV_PENDING_OLD and still cannot publish it.
      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_PENDING_OLD },
      });
      expect(row.status).toBe('pending');
      expect(row.featured).toBe(false);
    });

    it('lets support READ but never decide', async () => {
      await http()
        .get('/api/hub/admin/events/queue')
        .set(auth(supportToken))
        .expect(200);
      await http()
        .get('/api/hub/admin/events')
        .set(auth(supportToken))
        .expect(200);
      await http()
        .get(`/api/hub/admin/events/${EV_PENDING_OLD}`)
        .set(auth(supportToken))
        .expect(200);

      const res = await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(supportToken))
        .expect(403);
      expect(res.body.message).toBe(
        'This action is not available to your admin role.',
      );
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/reject`)
        .set(auth(supportToken))
        .send({ reason: 'not mine to make' })
        .expect(403);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/feature`)
        .set(auth(supportToken))
        .expect(403);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/unfeature`)
        .set(auth(supportToken))
        .expect(403);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .set(auth(supportToken))
        .send({ reason: 'not mine to make' })
        .expect(403);
      await http()
        .post(`/api/hub/admin/events/${EV_REMOVED}/restore`)
        .set(auth(supportToken))
        .expect(403);

      expect(
        await prisma.adminEventReview.count({
          where: { eventId: { in: FIXTURE_IDS } },
        }),
      ).toBe(0);
    });

    it('refuses the finance role outright — events take no money, so none of this is a finance job', async () => {
      await http()
        .get('/api/hub/admin/events/queue')
        .set(auth(financeToken))
        .expect(403);
      await http()
        .get('/api/hub/admin/events')
        .set(auth(financeToken))
        .expect(403);
      await http()
        .get(`/api/hub/admin/events/${EV_PENDING_OLD}`)
        .set(auth(financeToken))
        .expect(403);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(financeToken))
        .expect(403);
      await http()
        .post(`/api/hub/admin/events/${EV_PUBLISHED}/remove`)
        .set(auth(financeToken))
        .send({ reason: 'not mine to make' })
        .expect(403);
    });

    it('lets superadmin and reviewer decide', async () => {
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_OLD}/approve`)
        .set(auth(superToken))
        .expect(200);
      await http()
        .post(`/api/hub/admin/events/${EV_PENDING_NEW}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
    });

    it('refuses a suspended admin mid-session', async () => {
      await prisma.adminUser.update({
        where: { id: ADMIN_REVIEWER_ID },
        data: { status: 'suspended' },
      });
      try {
        await http()
          .get('/api/hub/admin/events/queue')
          .set(auth(reviewerToken))
          .expect(401);
      } finally {
        await prisma.adminUser.update({
          where: { id: ADMIN_REVIEWER_ID },
          data: { status: 'active' },
        });
      }
    });
  });
});
