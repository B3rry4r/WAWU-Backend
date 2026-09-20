import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { ContentPieceModule } from '../../../content-piece/content-piece.module';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminContentReviewModule } from '../admin-content-review.module';

/**
 * Contract tests for the admin content-review surface
 * (admin-surface-extension Phase 6).
 *
 * The load-bearing assertion in this file is not that a column changed. It is
 * that approving a piece makes it visible on the EXISTING public read path —
 * `GET /api/hub/content/:id` and `GET /api/hub/content`, mounted here from the
 * real, unmodified ContentPieceModule and driven with a real WAWU ID user
 * token. Before this module existed nothing in the backend ever wrote
 * `status: 'live'`, so a creator's upload was invisible to every buyer
 * forever. Asserting the column would prove nothing about that; asserting the
 * buyer's own endpoint is the whole point.
 *
 * Also proved here: the queue lists only pending work, a rejection is refused
 * without a reason, a rejection hands the creator's upload slot back, the
 * audit row is written with who/when/why, a non-reviewer admin role is
 * refused, and a WAWU ID user token cannot reach any of it.
 *
 * Fixtures live under this suite's own `1c……` / `ac……` id prefixes and are
 * swept in afterAll (README § Test hygiene). No seeded row is mutated.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded plain (non-creator) WAWU ID user. mock-wawu-id keys its login on the email, not the sub. */
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'ac000000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'ac000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'ac000000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'ac000000-0000-4000-8000-000000000004';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_REVIEWER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID];

const SUPER_EMAIL = 'content-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'content-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'content-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'content-finance@admin.test.wawu.dev';
const PASSWORD = 'content-review-contract-password';

const TEST_ACCESS_SECRET = 'admin-content-review-access-secret-0123456789';
const TEST_REFRESH_SECRET = 'admin-content-review-refresh-secret-0123456789';

// ── suite-owned content fixtures ────────────────────────────────────────────
const CREATOR = '1c000000-0000-4000-8000-0000000000c1';
const CREATOR_STARTING_SLOTS = 3;
/** The flat per-account cap — see src/common/creator-allowance.ts. */
const CREATOR_SLOTS_TOTAL = 5;

const PIECE_PENDING_OLD = '1c000000-0000-4000-8000-000000000001';
const PIECE_PENDING_NEW = '1c000000-0000-4000-8000-000000000002';
const PIECE_LIVE = '1c000000-0000-4000-8000-000000000003';
const PIECE_REJECTED = '1c000000-0000-4000-8000-000000000004';
const PIECE_IDS = [PIECE_PENDING_OLD, PIECE_PENDING_NEW, PIECE_LIVE, PIECE_REJECTED];
const UNKNOWN_PIECE = '1c000000-0000-4000-8000-0000000000ff';

/**
 * A category no seeded or other-suite row uses, so the public list assertion
 * can filter to exactly this suite's pieces and never race the real feed.
 */
const FIXTURE_CATEGORY = 'admin-content-review-contract';

/**
 * Stored asset values, in the two shapes the data actually holds: content
 * uploads persist `presignUpload().fileUrl` (an absolute, already-signed
 * SEVEN-DAY URL), while KYC persists a bare object key. Both must come back
 * as a 900-second signed URL.
 */
const PREVIEW_STORED_URL =
  'https://bucket.example-storage.dev/content/preview/1c000000-0000-4000-8000-0000000000c1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg?X-Amz-Expires=604800&X-Amz-Signature=stale';
const FULL_STORED_KEY =
  'content/full/1c000000-0000-4000-8000-0000000000c1/ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4';

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Admin content review contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superToken: string;
  let reviewerToken: string;
  let supportToken: string;
  let financeToken: string;
  let userToken: string;

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

  /**
   * Puts every fixture back at its starting state. Run before each test
   * because the decision endpoints are the thing under test and they mutate
   * both the piece and the creator's slot counter.
   */
  async function resetContentFixtures(): Promise<void> {
    await prisma.adminContentReview.deleteMany({ where: { contentId: { in: PIECE_IDS } } });
    await prisma.contentPiece.deleteMany({ where: { id: { in: PIECE_IDS } } });
    await prisma.creatorState.upsert({
      where: { wawuUserId: CREATOR },
      update: { slotsUsed: CREATOR_STARTING_SLOTS },
      create: {
        wawuUserId: CREATOR,
        slotsUsed: CREATOR_STARTING_SLOTS,
      },
    });
    await prisma.userProfile.upsert({
      where: { wawuUserId: CREATOR },
      update: { accountType: 'creator' },
      create: { wawuUserId: CREATOR, accountType: 'creator', handle: 'contract-content-creator', interests: [] },
    });

    const base = {
      creatorWawuId: CREATOR,
      description: 'A fixture piece for the admin content-review contract suite.',
      category: FIXTURE_CATEGORY,
      tags: ['contract', 'fixture'],
      previewAssetUrl: PREVIEW_STORED_URL,
      fullAssetUrl: FULL_STORED_KEY,
    };

    await prisma.contentPiece.createMany({
      data: [
        {
          ...base,
          id: PIECE_PENDING_OLD,
          slug: 'admin-review-pending-old',
          title: 'Pending, waiting longest',
          contentType: 'video',
          accessType: 'paid',
          price: 2500,
          status: 'pending',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          ...base,
          id: PIECE_PENDING_NEW,
          slug: 'admin-review-pending-new',
          title: 'Pending, just arrived',
          contentType: 'pdf',
          accessType: 'free',
          price: 0,
          status: 'pending',
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          ...base,
          id: PIECE_LIVE,
          slug: 'admin-review-already-live',
          title: 'Already live',
          contentType: 'video',
          accessType: 'free',
          price: 0,
          status: 'live',
        },
        {
          ...base,
          id: PIECE_REJECTED,
          slug: 'admin-review-already-rejected',
          title: 'Already rejected',
          contentType: 'image',
          accessType: 'free',
          price: 0,
          status: 'rejected',
        },
      ],
    });
  }

  beforeAll(async () => {
    for (const key of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'STORAGE_ENDPOINT',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
      'STORAGE_BUCKET',
      'STORAGE_REGION',
    ]) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;
    // Presigning is pure local crypto — no network, no real bucket. These
    // credentials exist only so StorageService is CONFIGURED, which is what
    // lets the suite assert the URL it hands a reviewer is actually
    // short-lived rather than just "not null".
    process.env.STORAGE_ENDPOINT = 'https://bucket.example-storage.dev';
    process.env.STORAGE_ACCESS_KEY_ID = 'contract-test-key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'contract-test-secret';
    process.env.STORAGE_BUCKET = 'contract-test-bucket';
    process.env.STORAGE_REGION = 'auto';

    userToken = await loginToWawuId(USER_PLAIN_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminContentReviewModule,
        // The REAL public read path, unmodified, so "approved" can be proved
        // against what a buyer actually calls rather than against a column.
        WawuAuthModule,
        ContentPieceModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, name: 'Content Super', role: 'superadmin', passwordHash },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, name: 'Content Reviewer', role: 'reviewer', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'Content Support', role: 'support', passwordHash },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'Content Finance', role: 'finance', passwordHash },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
  });

  beforeEach(async () => {
    await resetContentFixtures();
  });

  afterAll(async () => {
    await prisma.adminContentReview.deleteMany({ where: { contentId: { in: PIECE_IDS } } });
    await prisma.contentPiece.deleteMany({ where: { id: { in: PIECE_IDS } } });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: CREATOR } });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: CREATOR } });
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── GET /admin/content/queue ──────────────────────────────────────────────

  describe('GET /api/hub/admin/content/queue', () => {
    it('lists ONLY pending pieces, oldest first, in the standard envelope', async () => {
      const res = await http()
        .get('/api/hub/admin/content/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.pagination).toMatchObject({ currentPage: 1, perPage: 100 });

      const ids: string[] = res.body.data.map((i: { id: string }) => i.id);
      expect(ids).toContain(PIECE_PENDING_OLD);
      expect(ids).toContain(PIECE_PENDING_NEW);
      expect(ids).not.toContain(PIECE_LIVE);
      expect(ids).not.toContain(PIECE_REJECTED);
      expect(res.body.data.every((i: { status: string }) => i.status === 'pending')).toBe(true);

      // Oldest first is the default and the whole point of a review queue.
      expect(ids.indexOf(PIECE_PENDING_OLD)).toBeLessThan(ids.indexOf(PIECE_PENDING_NEW));
    });

    it('honours ?sort=newest', async () => {
      const res = await http()
        .get('/api/hub/admin/content/queue')
        .query({ perPage: 100, sort: 'newest' })
        .set(auth(reviewerToken))
        .expect(200);
      const ids: string[] = res.body.data.map((i: { id: string }) => i.id);
      expect(ids.indexOf(PIECE_PENDING_NEW)).toBeLessThan(ids.indexOf(PIECE_PENDING_OLD));
    });

    it('carries everything a reviewer needs to judge, including the creator block', async () => {
      const res = await http()
        .get('/api/hub/admin/content/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const item = res.body.data.find((i: { id: string }) => i.id === PIECE_PENDING_OLD);
      expect(item).toMatchObject({
        title: 'Pending, waiting longest',
        description: 'A fixture piece for the admin content-review contract suite.',
        category: FIXTURE_CATEGORY,
        contentType: 'video',
        accessType: 'paid',
        price: 2500,
        status: 'pending',
      });
      expect(item.waitingHours).toBeGreaterThan(0);
      expect(item.creator).toMatchObject({
        wawuUserId: CREATOR,
        handle: 'contract-content-creator',
        accountType: 'creator',
        slotsUsed: CREATOR_STARTING_SLOTS,
        // Derived with the same uploadAllowanceFor() the app uses — never a
        // second definition (law 13). Flat per account now, no tier ladder.
        slotsTotal: CREATOR_SLOTS_TOTAL,
      });
      // Hazard H-5: the app synthesizes 'not_started' for a creator who has
      // never submitted KYC. A reviewer must see the same word the creator
      // sees, so this reproduces it rather than reporting raw 'pending'.
      expect(item.creator.kycStatus).toBe('not_started');
    });

    it('hands back SHORT-LIVED signed asset URLs for both the preview and the full asset', async () => {
      const res = await http()
        .get('/api/hub/admin/content/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const item = res.body.data.find((i: { id: string }) => i.id === PIECE_PENDING_OLD);
      expect(item.assets.hasFullAsset).toBe(true);

      for (const url of [item.assets.previewUrl, item.assets.fullUrl]) {
        expect(typeof url).toBe('string');
        // 900 seconds — StorageService.signedReadUrl, the same path KYC
        // documents use. NOT readUrlFor's 604800.
        expect(url).toContain('X-Amz-Expires=900');
        expect(url).not.toContain('X-Amz-Expires=604800');
      }

      // The stored preview value is itself a stale 7-day URL; the key is
      // recovered from it and re-signed rather than echoed back.
      expect(item.assets.previewUrl).toContain('content/preview/');
      expect(item.assets.previewUrl).not.toContain('X-Amz-Signature=stale');
      expect(item.assets.fullUrl).toContain('content/full/');
    });

    it('never persists or echoes a signed URL into the stored row', async () => {
      await http()
        .get('/api/hub/admin/content/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id: PIECE_PENDING_OLD } });
      expect(row.previewAssetUrl).toBe(PREVIEW_STORED_URL);
      expect(row.fullAssetUrl).toBe(FULL_STORED_KEY);
    });

    it('400s on an unknown query property and on an out-of-range perPage', async () => {
      await http()
        .get('/api/hub/admin/content/queue')
        .query({ status: 'live' })
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .get('/api/hub/admin/content/queue')
        .query({ perPage: 500 })
        .set(auth(reviewerToken))
        .expect(400);
    });
  });

  // ── GET /admin/content/:id ────────────────────────────────────────────────

  describe('GET /api/hub/admin/content/:id', () => {
    it('returns full detail for a pending piece, including an empty review history', async () => {
      const res = await http()
        .get(`/api/hub/admin/content/${PIECE_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: PIECE_PENDING_OLD,
        slug: 'admin-review-pending-old',
        status: 'pending',
        views: 0,
        likes: 0,
        commentCount: 0,
        completedPurchaseCount: 0,
      });
      expect(res.body.data.lessons).toEqual([]);
      expect(res.body.data.reviewHistory).toEqual([]);
      expect(res.body.data.assets.fullUrl).toContain('X-Amz-Expires=900');
    });

    it('reaches a piece at any status, so a reviewer can revisit a decision', async () => {
      await http().get(`/api/hub/admin/content/${PIECE_LIVE}`).set(auth(reviewerToken)).expect(200);
      await http().get(`/api/hub/admin/content/${PIECE_REJECTED}`).set(auth(reviewerToken)).expect(200);
    });

    it('404s an unknown id and 400s a non-uuid id', async () => {
      const res = await http().get(`/api/hub/admin/content/${UNKNOWN_PIECE}`).set(auth(reviewerToken)).expect(404);
      expect(res.body).toEqual({ statusCode: 404, message: 'Content not found.', data: null });
      await http().get('/api/hub/admin/content/not-a-uuid').set(auth(reviewerToken)).expect(400);
    });
  });

  // ── POST /admin/content/:id/approve ───────────────────────────────────────

  describe('POST /api/hub/admin/content/:id/approve', () => {
    it('flips pending -> live and makes the piece visible on the EXISTING public read path', async () => {
      // Before: the buyer's own endpoint cannot see it. This is the state
      // every uploaded piece in this product has been stuck in.
      await http()
        .get(`/api/hub/content/${PIECE_PENDING_OLD}`)
        .set(auth(userToken))
        .expect(404);

      const res = await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(res.body.data.content.status).toBe('live');

      // After: the same unmodified app endpoint, same user token, 200.
      const seen = await http()
        .get(`/api/hub/content/${PIECE_PENDING_OLD}`)
        .set(auth(userToken))
        .expect(200);
      expect(seen.body.data).toMatchObject({ id: PIECE_PENDING_OLD, status: 'live' });
    });

    it('makes the piece appear in the app-facing content list too', async () => {
      const before = await http()
        .get('/api/hub/content')
        .query({ category: FIXTURE_CATEGORY, sort: 'recent', perPage: 100 })
        .set(auth(userToken))
        .expect(200);
      expect(before.body.data.map((i: { id: string }) => i.id)).not.toContain(PIECE_PENDING_OLD);

      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);

      const after = await http()
        .get('/api/hub/content')
        .query({ category: FIXTURE_CATEGORY, sort: 'recent', perPage: 100 })
        .set(auth(userToken))
        .expect(200);
      expect(after.body.data.map((i: { id: string }) => i.id)).toContain(PIECE_PENDING_OLD);
    });

    it('writes an audit row naming who approved it, when, and from which status', async () => {
      const res = await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(superToken))
        .expect(200);

      expect(res.body.data.review).toMatchObject({
        decision: 'approved',
        previousStatus: 'pending',
        newStatus: 'live',
        reason: null,
        slotReturned: false,
        reviewedByAdminId: ADMIN_SUPER_ID,
        reviewedByAdminEmail: SUPER_EMAIL,
        reviewedByAdminRole: 'superadmin',
      });

      const rows = await prisma.adminContentReview.findMany({ where: { contentId: PIECE_PENDING_OLD } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        creatorWawuId: CREATOR,
        decision: 'approved',
        reviewedByAdminId: ADMIN_SUPER_ID,
        reviewedByAdminEmail: SUPER_EMAIL,
        reviewedByAdminRole: 'superadmin',
      });
      expect(rows[0].reviewedAt).toBeInstanceOf(Date);

      // And the decision shows up in the piece's own history.
      const detail = await http()
        .get(`/api/hub/admin/content/${PIECE_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(detail.body.data.reviewHistory).toHaveLength(1);
      expect(detail.body.data.reviewHistory[0].reviewedByAdminEmail).toBe(SUPER_EMAIL);
    });

    it('does NOT touch the creator upload slot on approval', async () => {
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
      const state = await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: CREATOR } });
      expect(state.slotsUsed).toBe(CREATOR_STARTING_SLOTS);
    });

    it('400s on a piece that is not pending, and writes no second audit row', async () => {
      const res = await http()
        .post(`/api/hub/admin/content/${PIECE_LIVE}/approve`)
        .set(auth(reviewerToken))
        .expect(400);
      expect(res.body.message).toBe('Only a pending piece can be reviewed — this one is already live.');
      expect(await prisma.adminContentReview.count({ where: { contentId: PIECE_LIVE } })).toBe(0);
    });

    it('404s an unknown id', async () => {
      await http().post(`/api/hub/admin/content/${UNKNOWN_PIECE}/approve`).set(auth(reviewerToken)).expect(404);
    });
  });

  // ── POST /admin/content/:id/reject ────────────────────────────────────────

  describe('POST /api/hub/admin/content/:id/reject', () => {
    it('requires a reason', async () => {
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({})
        .expect(400);

      // A single space is not a reason.
      const res = await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: '   ' })
        .expect(400);
      expect(res.body.message).toBe('reason is required — the creator is shown it.');

      // Nothing was written on either refusal.
      const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id: PIECE_PENDING_OLD } });
      expect(row.status).toBe('pending');
      expect(await prisma.adminContentReview.count({ where: { contentId: PIECE_PENDING_OLD } })).toBe(0);
    });

    it('flips pending -> rejected, keeps it off the public read path, and records the reason', async () => {
      const res = await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'The preview is the same file as the full asset.' })
        .expect(200);

      expect(res.body.data.content.status).toBe('rejected');
      expect(res.body.data.review).toMatchObject({
        decision: 'rejected',
        previousStatus: 'pending',
        newStatus: 'rejected',
        reason: 'The preview is the same file as the full asset.',
        slotReturned: true,
      });

      await http().get(`/api/hub/content/${PIECE_PENDING_OLD}`).set(auth(userToken)).expect(404);
    });

    it('RETURNS the creator upload slot, atomically with the status change', async () => {
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Category does not match the content.' })
        .expect(200);

      const state = await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: CREATOR } });
      expect(state.slotsUsed).toBe(CREATOR_STARTING_SLOTS - 1);

      const row = await prisma.adminContentReview.findFirstOrThrow({
        where: { contentId: PIECE_PENDING_OLD },
      });
      expect(row.slotReturned).toBe(true);
    });

    it('never drives slotsUsed below zero, and says so on the audit row', async () => {
      await prisma.creatorState.update({ where: { wawuUserId: CREATOR }, data: { slotsUsed: 0 } });

      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Nothing to return.' })
        .expect(200);

      const state = await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: CREATOR } });
      expect(state.slotsUsed).toBe(0);
      const row = await prisma.adminContentReview.findFirstOrThrow({
        where: { contentId: PIECE_PENDING_OLD },
      });
      expect(row.slotReturned).toBe(false);
    });

    it('refuses a second decision on the same piece — one slot back, one audit row', async () => {
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'First and only decision.' })
        .expect(200);

      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Second attempt.' })
        .expect(400);
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(400);

      const state = await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: CREATOR } });
      expect(state.slotsUsed).toBe(CREATOR_STARTING_SLOTS - 1);
      expect(await prisma.adminContentReview.count({ where: { contentId: PIECE_PENDING_OLD } })).toBe(1);
    });

    it('400s a reason longer than 1000 characters', async () => {
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'x'.repeat(1001) })
        .expect(400);
    });
  });

  // ── auth + role matrix ────────────────────────────────────────────────────

  describe('who may reach this surface', () => {
    it('refuses an unauthenticated request on every route', async () => {
      await http().get('/api/hub/admin/content/queue').expect(401);
      await http().get(`/api/hub/admin/content/${PIECE_PENDING_OLD}`).expect(401);
      await http().post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`).expect(401);
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .send({ reason: 'nope' })
        .expect(401);
    });

    it('refuses a valid WAWU ID USER token — an app user cannot moderate', async () => {
      const res = await http().get('/api/hub/admin/content/queue').set(auth(userToken)).expect(401);
      expect(res.body.data).toBeNull();
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(userToken))
        .expect(401);

      // And the piece is untouched by the attempt.
      const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id: PIECE_PENDING_OLD } });
      expect(row.status).toBe('pending');
    });

    it('lets support READ the queue but not decide', async () => {
      await http().get('/api/hub/admin/content/queue').set(auth(supportToken)).expect(200);
      await http().get(`/api/hub/admin/content/${PIECE_PENDING_OLD}`).set(auth(supportToken)).expect(200);

      const res = await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(supportToken))
        .expect(403);
      expect(res.body.message).toBe('This action is not available to your admin role.');
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/reject`)
        .set(auth(supportToken))
        .send({ reason: 'not mine to make' })
        .expect(403);

      expect(await prisma.adminContentReview.count({ where: { contentId: PIECE_PENDING_OLD } })).toBe(0);
    });

    it('refuses the finance role outright — these responses carry signed URLs to unpublished paid assets', async () => {
      await http().get('/api/hub/admin/content/queue').set(auth(financeToken)).expect(403);
      await http().get(`/api/hub/admin/content/${PIECE_PENDING_OLD}`).set(auth(financeToken)).expect(403);
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(financeToken))
        .expect(403);
    });

    it('lets superadmin and reviewer decide', async () => {
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_OLD}/approve`)
        .set(auth(superToken))
        .expect(200);
      await http()
        .post(`/api/hub/admin/content/${PIECE_PENDING_NEW}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
    });

    it('refuses a suspended admin mid-session', async () => {
      await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { status: 'suspended' } });
      try {
        await http().get('/api/hub/admin/content/queue').set(auth(reviewerToken)).expect(401);
      } finally {
        await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { status: 'active' } });
      }
    });
  });
});
