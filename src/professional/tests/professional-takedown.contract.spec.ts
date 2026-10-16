import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { Client } from 'pg';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminProfessionalReviewModule } from '../../admin/professional-review/admin-professional-review.module';
import { ProfessionalModule } from '../professional.module';

/**
 * FIX-06: an admin's unlist holds until an admin reverses it.
 *
 * Before this task the admin's POST /admin/professionals/:id/unlist and the
 * person's Hide wrote the same `listed = false`, so the person's Show put a
 * pulled listing back. Everything here goes through the REAL routes: the
 * person's PATCH /professionals/applications/:id/listing (the route both the
 * web and the app call), the admin's unlist and relist, the web's directory
 * and profile (GET /professionals, /professionals/:id) and the app's
 * (GET /professionals/directory, /directory/:id), and P8's
 * GET /professionals/applications/mine/visibility.
 *
 * Fixtures live under this suite's own `f6……` listing ids and `ad06……` admin
 * ids and are swept in afterAll. No seeded row is changed.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const OWNER_EMAIL = 'creator-basic@test.wawu.dev';
const OWNER_SUB = '00000000-0000-4000-8000-000000000002';
const OTHER_EMAIL = 'user@test.wawu.dev';
const OTHER_SUB = '00000000-0000-4000-8000-000000000001';

const ADMIN_SUPER_ID = 'ad060000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'ad060000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'ad060000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'ad060000-0000-4000-8000-000000000004';
const ADMIN_IDS = [
  ADMIN_SUPER_ID,
  ADMIN_REVIEWER_ID,
  ADMIN_SUPPORT_ID,
  ADMIN_FINANCE_ID,
];
const SUPER_EMAIL = 'fix06-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'fix06-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'fix06-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'fix06-finance@admin.test.wawu.dev';
const PASSWORD = 'fix06-takedown-contract-password';
const TEST_ACCESS_SECRET = 'fix06-access-secret-0123456789abcdef0123';
const TEST_REFRESH_SECRET = 'fix06-refresh-secret-0123456789abcdef012';

/** The owner's approved listing, in a category the web's filter accepts. */
const LISTING = 'f6000000-0000-4000-8000-000000000001';
/** A second listing of the owner's, still pending. */
const PENDING = 'f6000000-0000-4000-8000-000000000002';
/** Another person's approved listing. */
const OTHERS = 'f6000000-0000-4000-8000-000000000003';
const FIXTURE_IDS = [LISTING, PENDING, OTHERS];
const UNKNOWN = 'f6000000-0000-4000-8000-0000000000ff';
const CATEGORY = 'technology';

/** The keys the web's PATCH .../listing answer carries (the protected lock). */
const LISTING_KEYS = [
  'about',
  'category',
  'credentialKind',
  'documents',
  'headline',
  'id',
  'issuingBody',
  'licenceNumber',
  'listed',
  'rejectionReason',
  'reviewedAt',
  'services',
  'status',
  'submittedAt',
  'wawuUserId',
];
/** The keys the dashboard's unlist answer carries (the protected lock). */
const DECISION_KEYS = [
  'id',
  'listed',
  'rejectionReason',
  'reviewedAt',
  'status',
];

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
  reason?: Record<string, unknown>;
}
type Row = Record<string, unknown>;

/** The response envelope, typed, so a test never reads an `any`. */
const bodyOf = <T = Row>(res: { body: unknown }) => res.body as Envelope<T>;
/** `data` of a response. */
const dataOf = <T = Row>(res: { body: unknown }) => bodyOf<T>(res).data;

describe('FIX-06: an admin takedown of a professional listing (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let otherToken: string;
  let superToken: string;
  let reviewerToken: string;
  let supportToken: string;
  let financeToken: string;
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return dataOf<{ accessToken: string }>(res).accessToken;
  }

  const show = (listed: boolean, id = LISTING, token = ownerToken) =>
    http()
      .patch(`/api/hub/professionals/applications/${id}/listing`)
      .set(auth(token))
      .send({ listed });
  const unlist = (token = superToken, id = LISTING) =>
    http().post(`/api/hub/admin/professionals/${id}/unlist`).set(auth(token));
  const relist = (token = superToken, id = LISTING) =>
    http().post(`/api/hub/admin/professionals/${id}/relist`).set(auth(token));
  const visibility = (token = ownerToken) =>
    http()
      .get('/api/hub/professionals/applications/mine/visibility')
      .set(auth(token));
  const approve = (token = superToken, id = PENDING) =>
    http().post(`/api/hub/admin/professionals/${id}/approve`).set(auth(token));
  const reject = (token = superToken, id = PENDING) =>
    http()
      .post(`/api/hub/admin/professionals/${id}/reject`)
      .set(auth(token))
      .send({ reason: 'Please add a portfolio link that opens.' });
  const adminVisibility = (token = superToken, id = LISTING) =>
    http()
      .get(`/api/hub/admin/professionals/${id}/visibility`)
      .set(auth(token));

  /** Requests in this database waiting on a lock, right now. */
  async function lockWaiters(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS "n" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;
    return rows[0]?.n ?? 0;
  }

  /** Waits until `n` requests queue behind the held row, so their order is known. */
  async function untilWaiting(n: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while ((await lockWaiters()) < n) {
      if (Date.now() > deadline) {
        throw new Error(`fewer than ${n} requests waited on the row`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Holds one listing's row, as a decision in flight does, until `release`.
   * Requests started meanwhile queue behind it in the order they arrive.
   */
  async function holdRow(
    id: string,
  ): Promise<{ release: () => Promise<void> }> {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      'SELECT "id" FROM "ProfessionalProfile" WHERE "id" = $1 FOR UPDATE',
      [id],
    );
    return {
      release: async () => {
        await holder.query('COMMIT');
        await holder.end();
      },
    };
  }

  /** What main answers for a decision on an application already decided. */
  const decided = (status: string) => ({
    statusCode: 409,
    message: `This application is already ${status}.`,
    data: null,
  });

  /**
   * Whether the listing is in front of buyers, on every surface that shows
   * one: the web's directory and profile, the app's directory and profile.
   */
  async function inDirectory(
    id = LISTING,
    category = CATEGORY,
  ): Promise<boolean> {
    const [web, app_, webProfile, appProfile] = await Promise.all([
      http().get('/api/hub/professionals').query({ category, perPage: 50 }),
      http().get('/api/hub/professionals/directory').query({ perPage: 50 }),
      http().get(`/api/hub/professionals/${id}`),
      http().get(`/api/hub/professionals/directory/${id}`),
    ]);
    const onWeb = dataOf<Array<{ id: string }>>(web).some((r) => r.id === id);
    const onApp = dataOf<Array<{ id: string }>>(app_).some((r) => r.id === id);
    // All four agree, or something reads `listed` differently somewhere.
    expect([
      onApp,
      webProfile.status === 200,
      appProfile.status === 200,
    ]).toEqual([onWeb, onWeb, onWeb]);
    if (!onWeb)
      expect([webProfile.status, appProfile.status]).toEqual([404, 404]);
    return onWeb;
  }

  const listedInDb = async (id = LISTING) =>
    (
      await prisma.professionalProfile.findUniqueOrThrow({
        where: { id },
        select: { listed: true },
      })
    ).listed;

  const takedownRow = (id = LISTING) =>
    prisma.professionalTakedown.findUnique({ where: { professionalId: id } });

  async function sweep(): Promise<void> {
    await prisma.professionalTakedown.deleteMany({
      where: { professionalId: { in: FIXTURE_IDS } },
    });
    await prisma.professionalProfile.deleteMany({
      where: { id: { in: FIXTURE_IDS } },
    });
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: OWNER_SUB, category: { in: [CATEGORY, 'beauty'] } },
    });
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: OTHER_SUB, category: CATEGORY },
    });
  }

  async function resetFixtures(): Promise<void> {
    await sweep();
    const base = {
      headline: 'Backend engineer, 9 years',
      about: 'I build payment integrations, mostly NestJS and Postgres.',
      services: ['API review'],
      credentialKind: 'portfolio' as const,
    };
    await prisma.professionalProfile.createMany({
      data: [
        {
          ...base,
          id: LISTING,
          wawuUserId: OWNER_SUB,
          category: CATEGORY,
          status: 'approved',
          reviewedAt: new Date('2026-09-01T10:00:00.000Z'),
          listed: true,
        },
        {
          ...base,
          id: PENDING,
          wawuUserId: OWNER_SUB,
          category: 'beauty',
          status: 'pending',
          listed: true,
        },
        {
          ...base,
          id: OTHERS,
          wawuUserId: OTHER_SUB,
          category: CATEGORY,
          status: 'approved',
          reviewedAt: new Date('2026-09-01T10:00:00.000Z'),
          listed: true,
        },
      ],
    });
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    [ownerToken, otherToken] = await Promise.all([
      loginToWawuId(OWNER_EMAIL),
      loginToWawuId(OTHER_EMAIL),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminProfessionalReviewModule,
        ProfessionalModule,
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
          name: 'Fix06 Super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: ADMIN_REVIEWER_ID,
          email: REVIEWER_EMAIL,
          name: 'Fix06 Reviewer',
          role: 'reviewer',
          passwordHash,
        },
        {
          id: ADMIN_SUPPORT_ID,
          email: SUPPORT_EMAIL,
          name: 'Fix06 Support',
          role: 'support',
          passwordHash,
        },
        {
          id: ADMIN_FINANCE_ID,
          email: FINANCE_EMAIL,
          name: 'Fix06 Finance',
          role: 'finance',
          passwordHash,
        },
      ],
    });
    superToken = await adminLogin(SUPER_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
  }, 60_000);

  beforeEach(async () => {
    await resetFixtures();
  });

  afterAll(async () => {
    await sweep();
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await app?.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── capability 1 ──────────────────────────────────────────────────────────

  it("an admin unlists a listing; the owner's Show is refused and every directory still hides it", async () => {
    expect(await inDirectory()).toBe(true);

    const pulled = await unlist().expect(200);
    // The dashboard's answer is the one it always got: the same five keys.
    expect(Object.keys(dataOf(pulled)).sort()).toEqual(DECISION_KEYS);
    expect(dataOf(pulled)).toMatchObject({
      id: LISTING,
      status: 'approved',
      listed: false,
    });
    expect(await inDirectory()).toBe(false);

    const refused = await show(true).expect(409);
    expect(bodyOf(refused).message).toBe(
      'This listing was taken down by an admin and cannot be shown. It stays hidden until an admin lists it again.',
    );
    expect(bodyOf(refused).message).not.toMatch(/\u2014/);
    expect(bodyOf(refused).reason?.code).toBe('listing_taken_down');
    expect(
      new Date(String(bodyOf(refused).reason?.takenDownAt)).getTime(),
    ).not.toBeNaN();
    expect(dataOf(refused)).toBeNull();

    expect(await listedInDb()).toBe(false);
    expect(await inDirectory()).toBe(false);

    // Who took it down and when is recorded, with what the owner had chosen.
    const row = await takedownRow();
    expect(row).toMatchObject({
      wawuUserId: OWNER_SUB,
      ownerListed: true,
      takenDownByAdminId: ADMIN_SUPER_ID,
      takenDownByAdminEmail: SUPER_EMAIL,
      takenDownByAdminRole: 'superadmin',
      liftedAt: null,
      liftedByAdminId: null,
    });
  });

  it("P8 reads the takedown: the listing's visibility is taken_down, with when", async () => {
    let res = await visibility().expect(200);
    expect(dataOf(res)).toEqual([
      {
        id: LISTING,
        category: CATEGORY,
        visibility: 'listed',
        takenDownAt: null,
      },
    ]);

    await unlist().expect(200);
    res = await visibility().expect(200);
    expect(dataOf(res)).toHaveLength(1);
    expect(dataOf<Row[]>(res)[0]).toMatchObject({
      id: LISTING,
      category: CATEGORY,
      visibility: 'taken_down',
    });
    const row = await takedownRow();
    expect(dataOf<Row[]>(res)[0].takenDownAt).toBe(
      row!.takenDownAt.toISOString(),
    );

    // Another person sees only their own listing, never the owner's.
    const theirs = await visibility(otherToken).expect(200);
    expect(dataOf(theirs)).toEqual([
      {
        id: OTHERS,
        category: CATEGORY,
        visibility: 'listed',
        takenDownAt: null,
      },
    ]);
    await http()
      .get('/api/hub/professionals/applications/mine/visibility')
      .expect(401);
  });

  it('a Hide while it is down is accepted and kept: lifting the takedown leaves it hidden', async () => {
    await unlist().expect(200);
    const hid = await show(false).expect(200);
    expect(dataOf(hid).listed).toBe(false);
    expect((await takedownRow())!.ownerListed).toBe(false);
    // Still down, still refused.
    await show(true).expect(409);

    const lifted = await relist().expect(200);
    expect(Object.keys(dataOf(lifted)).sort()).toEqual(DECISION_KEYS);
    expect(dataOf(lifted).listed).toBe(false);
    expect(await inDirectory()).toBe(false);
    expect(dataOf<Row[]>(await visibility().expect(200))[0].visibility).toBe(
      'hidden',
    );

    // Their own Show now works, as before.
    await show(true).expect(200);
    expect(await inDirectory()).toBe(true);
  });

  // ── capability 2 ──────────────────────────────────────────────────────────

  it('an admin lists it again; the owner hides and shows it as before', async () => {
    await unlist().expect(200);
    const lifted = await relist(reviewerToken).expect(200);
    expect(dataOf(lifted)).toMatchObject({
      id: LISTING,
      status: 'approved',
      listed: true,
    });
    expect(await inDirectory()).toBe(true);
    expect(dataOf<Row[]>(await visibility().expect(200))[0]).toMatchObject({
      visibility: 'listed',
      takenDownAt: null,
    });

    const row = await takedownRow();
    expect(row!.liftedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({
      liftedByAdminId: ADMIN_REVIEWER_ID,
      liftedByAdminEmail: REVIEWER_EMAIL,
      liftedByAdminRole: 'reviewer',
      // The takedown itself is still on record.
      takenDownByAdminId: ADMIN_SUPER_ID,
    });

    expect(dataOf(await show(false).expect(200)).listed).toBe(false);
    expect(await inDirectory()).toBe(false);
    expect(dataOf(await show(true).expect(200)).listed).toBe(true);
    expect(await inDirectory()).toBe(true);
  });

  it("a second takedown after a lift starts a new one, from the owner's choice at that time", async () => {
    await unlist().expect(200);
    await relist().expect(200);
    await show(false).expect(200);

    await unlist(reviewerToken).expect(200);
    const row = await takedownRow();
    expect(row).toMatchObject({
      ownerListed: false,
      takenDownByAdminId: ADMIN_REVIEWER_ID,
      liftedAt: null,
      liftedByAdminId: null,
      liftedByAdminEmail: null,
      liftedByAdminRole: null,
    });
    await show(true).expect(409);
    await relist().expect(200);
    expect(await listedInDb()).toBe(false);
  });

  it('unlisting a listing that is already down changes nothing: the first takedown stands', async () => {
    await unlist().expect(200);
    const first = await takedownRow();
    const again = await unlist(reviewerToken).expect(200);
    expect(Object.keys(dataOf(again)).sort()).toEqual(DECISION_KEYS);
    expect(dataOf(again).listed).toBe(false);
    const row = await takedownRow();
    expect(row!.takenDownByAdminId).toBe(ADMIN_SUPER_ID);
    expect(row!.takenDownAt.toISOString()).toBe(
      first!.takenDownAt.toISOString(),
    );
    expect(row!.ownerListed).toBe(true);
  });

  it("relist refuses a listing no admin took down, and leaves the owner's Hide alone", async () => {
    await show(false).expect(200);
    const res = await relist().expect(409);
    expect(bodyOf(res).reason).toEqual({ code: 'listing_not_taken_down' });
    expect(bodyOf(res).message).not.toMatch(/\u2014/);
    expect(await listedInDb()).toBe(false);
    expect(await takedownRow()).toBeNull();
    await relist(superToken, UNKNOWN).expect(404);
  });

  it('only a superadmin or a reviewer can list it again; a user token cannot reach it', async () => {
    await unlist().expect(200);
    await relist(supportToken).expect(403);
    await relist(financeToken).expect(403);
    await relist(ownerToken).expect(401);
    await http()
      .post(`/api/hub/admin/professionals/${LISTING}/relist`)
      .expect(401);
    expect(await listedInDb()).toBe(false);
    await relist(reviewerToken).expect(200);
  });

  // ── capability 3 ──────────────────────────────────────────────────────────

  it("the owner's own Hide and Show on a listing no admin pulled behave exactly as before", async () => {
    const hid = await show(false).expect(200);
    expect(Object.keys(dataOf(hid)).sort()).toEqual(LISTING_KEYS);
    expect(dataOf(hid)).toMatchObject({ id: LISTING, listed: false });
    expect(await inDirectory()).toBe(false);
    expect(dataOf<Row[]>(await visibility().expect(200))[0].visibility).toBe(
      'hidden',
    );

    const shown = await show(true).expect(200);
    expect(Object.keys(dataOf(shown)).sort()).toEqual(LISTING_KEYS);
    expect(dataOf(shown).listed).toBe(true);
    expect(await inDirectory()).toBe(true);
    expect(await takedownRow()).toBeNull();

    // The refusals this route always gave, unchanged and without a reason.
    const pending = await show(true, PENDING).expect(409);
    expect(bodyOf(pending).message).toBe(
      'Only an approved professional profile can be hidden or shown.',
    );
    expect(bodyOf(pending).reason).toBeUndefined();
    const notYours = await show(true, OTHERS).expect(403);
    expect(bodyOf(notYours).reason).toBeUndefined();
    await show(true, UNKNOWN).expect(404);
  });

  it("a listing hidden before this task (listed = false, no takedown row) is the owner's own Hide: their Show works", async () => {
    // What the migration leaves every existing hidden listing as.
    await prisma.professionalProfile.update({
      where: { id: LISTING },
      data: { listed: false },
    });
    expect(await takedownRow()).toBeNull();
    expect(dataOf<Row[]>(await visibility().expect(200))[0].visibility).toBe(
      'hidden',
    );
    expect(dataOf(await show(true).expect(200)).listed).toBe(true);
    expect(await inDirectory()).toBe(true);
  });

  it('an unlist and a Show at the same moment never leave a takedown with the listing shown', async () => {
    for (let round = 0; round < 8; round += 1) {
      await resetFixtures();
      await show(false).expect(200);
      const [s, u] = await Promise.all([show(true), unlist()]);
      expect(u.status).toBe(200);
      expect([200, 409]).toContain(s.status);
      expect((await takedownRow())?.liftedAt).toBeNull();
      expect(await listedInDb()).toBe(false);
    }
  });

  it('a Show that arrives while an admin is taking the listing down waits for it, then is refused', async () => {
    // The admin's unlist, held open half way: the listing's row locked, the
    // takedown written, nothing committed yet.
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query(
        'SELECT "id" FROM "ProfessionalProfile" WHERE "id" = $1 FOR UPDATE',
        [LISTING],
      );
      await admin.query(
        `INSERT INTO "ProfessionalTakedown"
           ("professionalId", "wawuUserId", "ownerListed", "takenDownByAdminId", "takenDownByAdminEmail", "takenDownByAdminRole")
         VALUES ($1, $2, true, $3, $4, 'superadmin')`,
        [LISTING, OWNER_SUB, ADMIN_SUPER_ID, SUPER_EMAIL],
      );
      await admin.query(
        'UPDATE "ProfessionalProfile" SET "listed" = false WHERE "id" = $1',
        [LISTING],
      );

      const showing = show(true).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await admin.query('COMMIT');

      const res = await showing;
      expect(res.status).toBe(409);
      expect(bodyOf(res).reason?.code).toBe('listing_taken_down');
    } finally {
      await admin.end();
    }
    expect(await listedInDb()).toBe(false);
    expect(await inDirectory()).toBe(false);
  });

  // ── round 2: decisions race a takedown (D1) ───────────────────────────────

  it('two approves and an unlist in the verifier order: the late approve is refused as main refuses a decided application, and the takedown holds', async () => {
    const row = await holdRow(PENDING);
    let first: request.Response;
    let pull: request.Response;
    let late: request.Response;
    try {
      const firstP = approve(superToken).then((r) => r);
      await untilWaiting(1);
      const pullP = unlist(superToken, PENDING).then((r) => r);
      await untilWaiting(2);
      const lateP = approve(reviewerToken).then((r) => r);
      await untilWaiting(3);
      await row.release();
      [first, pull, late] = await Promise.all([firstP, pullP, lateP]);
    } finally {
      await row.release().catch(() => undefined);
    }

    expect(first.status).toBe(200);
    expect(dataOf(first)).toMatchObject({ status: 'approved', listed: true });
    expect(pull.status).toBe(200);
    expect(late.status).toBe(409);
    expect(late.body).toEqual(decided('approved'));

    const after = await prisma.professionalProfile.findUniqueOrThrow({
      where: { id: PENDING },
      select: { status: true, listed: true },
    });
    expect(after).toEqual({ status: 'approved', listed: false });
    expect((await takedownRow(PENDING))?.liftedAt).toBeNull();
    expect(await inDirectory(PENDING, 'beauty')).toBe(false);
    await show(true, PENDING).expect(409);
  });

  it('approve, unlist, then a reject that read pending before the approve: the reject is refused and the takedown holds', async () => {
    const row = await holdRow(PENDING);
    let yes: request.Response;
    let pull: request.Response;
    let no: request.Response;
    try {
      const yesP = approve(superToken).then((r) => r);
      await untilWaiting(1);
      const pullP = unlist(superToken, PENDING).then((r) => r);
      await untilWaiting(2);
      const noP = reject(reviewerToken).then((r) => r);
      await untilWaiting(3);
      await row.release();
      [yes, pull, no] = await Promise.all([yesP, pullP, noP]);
    } finally {
      await row.release().catch(() => undefined);
    }

    expect([yes.status, pull.status, no.status]).toEqual([200, 200, 409]);
    expect(no.body).toEqual(decided('approved'));
    const after = await prisma.professionalProfile.findUniqueOrThrow({
      where: { id: PENDING },
      select: { status: true, listed: true, rejectionReason: true },
    });
    expect(after).toEqual({
      status: 'approved',
      listed: false,
      rejectionReason: null,
    });
    expect((await takedownRow(PENDING))?.liftedAt).toBeNull();
    await show(true, PENDING).expect(409);
  });

  it('a takedown survives a rejection and a fresh application: the new approval stays taken down until an admin lists it again', async () => {
    await show(false).expect(200);
    await unlist().expect(200);
    // The state the verifier's reject race reached on round 1's code: the
    // application turned down with the takedown still standing.
    await prisma.professionalProfile.update({
      where: { id: LISTING },
      data: { status: 'rejected', rejectionReason: 'Fix the link.' },
    });

    const again = await http()
      .post('/api/hub/professionals/applications')
      .set(auth(ownerToken))
      .send({
        category: CATEGORY,
        headline: 'Backend engineer, 10 years',
        about: 'I build payment integrations, mostly NestJS and Postgres.',
        services: ['API review'],
        credentialKind: 'portfolio',
      })
      .expect(201);
    expect(dataOf(again)).toMatchObject({ id: LISTING, status: 'pending' });

    const approved = await approve(superToken, LISTING).expect(200);
    expect(dataOf(approved)).toMatchObject({
      status: 'approved',
      listed: false,
    });
    expect(await inDirectory()).toBe(false);
    expect(dataOf<Row[]>(await visibility().expect(200))[0]).toMatchObject({
      id: LISTING,
      visibility: 'taken_down',
    });
    await show(true).expect(409);
    // A fresh approval lists by default, so lifting it lists it.
    expect((await takedownRow())!.ownerListed).toBe(true);

    expect(dataOf(await relist().expect(200)).listed).toBe(true);
    expect(await inDirectory()).toBe(true);
  });

  it('approve and reject of a decided or unknown application answer exactly what they answered before', async () => {
    await approve().expect(200);
    expect((await approve().expect(409)).body).toEqual(decided('approved'));
    expect((await reject().expect(409)).body).toEqual(decided('approved'));
    expect((await approve(superToken, UNKNOWN).expect(404)).body).toEqual({
      statusCode: 404,
      message: 'Application not found',
      data: null,
    });
    expect((await reject(superToken, UNKNOWN).expect(404)).body).toEqual({
      statusCode: 404,
      message: 'Application not found',
      data: null,
    });
    await resetFixtures();
    await reject().expect(200);
    expect((await approve().expect(409)).body).toEqual(decided('rejected'));
    expect((await reject().expect(409)).body).toEqual(decided('rejected'));
    // The approve with no takedown still lists, as it always did.
    await resetFixtures();
    expect(dataOf(await approve().expect(200))).toMatchObject({
      listed: true,
    });
    expect(await inDirectory(PENDING, 'beauty')).toBe(true);
  });

  // ── round 2: the dashboard's read of the takedown state ───────────────────

  it('an admin reads where a listing stands and the latest takedown, without the protected answers changing', async () => {
    let res = await adminVisibility().expect(200);
    expect(dataOf(res)).toEqual({
      id: LISTING,
      status: 'approved',
      visibility: 'listed',
      takenDownAt: null,
      latestTakedown: null,
    });

    await show(false).expect(200);
    expect(dataOf(await adminVisibility().expect(200)).visibility).toBe(
      'hidden',
    );

    await unlist(reviewerToken).expect(200);
    res = await adminVisibility().expect(200);
    const row = await takedownRow();
    expect(dataOf(res)).toEqual({
      id: LISTING,
      status: 'approved',
      visibility: 'taken_down',
      takenDownAt: row!.takenDownAt.toISOString(),
      latestTakedown: {
        standing: true,
        takenDownAt: row!.takenDownAt.toISOString(),
        takenDownByAdminId: ADMIN_REVIEWER_ID,
        takenDownByAdminEmail: REVIEWER_EMAIL,
        takenDownByAdminRole: 'reviewer',
        relistsAs: 'hidden',
        liftedAt: null,
        liftedByAdminId: null,
        liftedByAdminEmail: null,
        liftedByAdminRole: null,
      },
    });

    await relist(superToken).expect(200);
    res = await adminVisibility(reviewerToken).expect(200);
    expect(dataOf(res)).toMatchObject({
      visibility: 'hidden',
      takenDownAt: null,
      latestTakedown: {
        standing: false,
        takenDownByAdminEmail: REVIEWER_EMAIL,
        liftedByAdminId: ADMIN_SUPER_ID,
        liftedByAdminEmail: SUPER_EMAIL,
        liftedByAdminRole: 'superadmin',
      },
    });

    // Not a listing yet: no visibility.
    expect(
      dataOf(await adminVisibility(superToken, PENDING).expect(200)),
    ).toEqual({
      id: PENDING,
      status: 'pending',
      visibility: null,
      takenDownAt: null,
      latestTakedown: null,
    });
    await adminVisibility(superToken, UNKNOWN).expect(404);

    // Roles as unlist: support and finance refused, a person's token and none 401.
    await adminVisibility(supportToken).expect(403);
    await adminVisibility(financeToken).expect(403);
    await adminVisibility(ownerToken).expect(401);
    await http()
      .get(`/api/hub/admin/professionals/${LISTING}/visibility`)
      .expect(401);
  });
});
