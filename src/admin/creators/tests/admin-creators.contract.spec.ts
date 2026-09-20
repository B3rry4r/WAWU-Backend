import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminCreatorsModule } from '../admin-creators.module';

/**
 * Contract tests for the admin creator-lookup surface
 * (admin-surface-extension Phase 6).
 *
 * Three things are load-bearing here, and none of them is "the endpoint
 * returns 200":
 *
 *  1. The EARNING gate and the verification badge stay INDEPENDENT.
 *     `kycStatus` is asserted as its own field, the badge as its own, and the
 *     response is asserted to contain no merged `verified` boolean anywhere.
 *     The upload gate that used to sit beside them was a paid subscription;
 *     it is gone, and no field reports a fixed value in its place.
 *  2. A creator row with no UserProfile still opens rather than 404ing. That
 *     shape 403s the account out of every CreatorAccountGuard in the
 *     codebase, and is exactly the support call this screen answers.
 *  3. Search refuses what it cannot do. This backend stores no email and no
 *     phone for a creator account, so an operator pasting either gets a 400
 *     that explains why — never a 200 with an empty list, which reads as "this
 *     person does not exist" about somebody who definitely does.
 *
 * Also proved: no KYC document value (BVN, NIN, ID URL, payout bank, payout
 * account) appears anywhere in either response; handle search is partial and
 * case-insensitive; a wawuUserId that is all digits once its dashes are
 * stripped is not mistaken for a phone number; the filters and pagination
 * work; reviewer is refused; a WAWU ID user token is refused.
 *
 * Fixtures live under this suite's own `b1……` id prefix and are swept in
 * afterAll (README § Test hygiene). No seeded row is mutated.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded plain (non-creator) WAWU ID user. mock-wawu-id keys its login on the email, not the sub. */
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'b1000000-0000-4000-8000-0000000000d1';
const ADMIN_SUPPORT_ID = 'b1000000-0000-4000-8000-0000000000d2';
const ADMIN_FINANCE_ID = 'b1000000-0000-4000-8000-0000000000d3';
const ADMIN_REVIEWER_ID = 'b1000000-0000-4000-8000-0000000000d4';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID, ADMIN_REVIEWER_ID];

const SUPER_EMAIL = 'creators-super@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'creators-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'creators-finance@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'creators-reviewer@admin.test.wawu.dev';
const PASSWORD = 'admin-creators-contract-password';

const TEST_ACCESS_SECRET = 'admin-creators-access-secret-0123456789abc';
const TEST_REFRESH_SECRET = 'admin-creators-refresh-secret-0123456789abc';

// ── suite-owned account fixtures ────────────────────────────────────────────
/** Paid, uploading, KYC never submitted — the `not_started` synthesis. */
const CREATOR_PAID_NO_KYC = 'b1000000-0000-4000-8000-000000000001';
/** Paid, uploading, KYC submitted and waiting on a reviewer — "normal", per CLAUDE.md. */
const CREATOR_PAID_KYC_PENDING = 'b1000000-0000-4000-8000-000000000002';
/** Pro, with a downgrade to Basic booked at the end of the paid term. */
const CREATOR_PRO_DOWNGRADING = 'b1000000-0000-4000-8000-000000000003';
/** Unpaid: a CreatorState row exists but the upload gate is shut. */
const CREATOR_UNPAID = 'b1000000-0000-4000-8000-000000000004';
/** A plain user — no CreatorState at all. Findable, and honestly reported as such. */
const PLAIN_USER = 'b1000000-0000-4000-8000-000000000005';
/** CreatorState but NO UserProfile — the broken shape the detail endpoint must still open. */
const ORPHANED_STATE = 'b1000000-0000-4000-8000-000000000006';

const FIXTURE_IDS = [
  CREATOR_PAID_NO_KYC,
  CREATOR_PAID_KYC_PENDING,
  CREATOR_PRO_DOWNGRADING,
  CREATOR_UNPAID,
  PLAIN_USER,
  ORPHANED_STATE,
];
const UNKNOWN_USER = 'b1000000-0000-4000-8000-0000000000ff';

/** Handles share this stem so `?q=` assertions can scope to this suite on a shared database. */
const HANDLE_STEM = 'ctrctcreators';

/** Values that must NEVER appear in an admin creator response. */
const FIXTURE_BVN = '22233344455';
const FIXTURE_NIN = '99988877766';
const FIXTURE_PAYOUT_ACCOUNT = '0123456789';
const FIXTURE_PAYOUT_BANK = 'Contract Test Bank';
const FIXTURE_ID_DOC_URL = 'kyc/b1000000/contract-test-id-document.jpg';

const PIECE_PENDING = 'b1000000-0000-4000-8000-0000000000e1';
const PIECE_LIVE = 'b1000000-0000-4000-8000-0000000000e2';
const PIECE_IDS = [PIECE_PENDING, PIECE_LIVE];

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

describe('Admin creator lookup contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superToken: string;
  let supportToken: string;
  let financeToken: string;
  let reviewerToken: string;
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

  async function clearFixtures(): Promise<void> {
    await prisma.contentPiece.deleteMany({ where: { id: { in: PIECE_IDS } } });
    await prisma.kycSubmission.deleteMany({ where: { wawuUserId: { in: FIXTURE_IDS } } });
    await prisma.verificationSubmission.deleteMany({
      where: { wawuUserId: { in: FIXTURE_IDS } },
    });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: { in: FIXTURE_IDS } } });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: FIXTURE_IDS } } });
  }

  async function seedFixtures(): Promise<void> {
    await clearFixtures();

    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: CREATOR_PAID_NO_KYC,
          accountType: 'creator',
          // Mixed case on purpose: the handle search must be case-insensitive.
          handle: `${HANDLE_STEM}-AdaNoKyc`,
          interests: [],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          wawuUserId: CREATOR_PAID_KYC_PENDING,
          accountType: 'creator',
          handle: `${HANDLE_STEM}-adaPending`,
          interests: [],
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        {
          wawuUserId: CREATOR_PRO_DOWNGRADING,
          accountType: 'creator',
          handle: `${HANDLE_STEM}-proDowngrade`,
          interests: [],
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        },
        {
          wawuUserId: CREATOR_UNPAID,
          accountType: 'creator',
          handle: `${HANDLE_STEM}-unpaid`,
          interests: [],
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
        {
          wawuUserId: PLAIN_USER,
          accountType: 'user',
          handle: `${HANDLE_STEM}-plainUser`,
          interests: [],
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
        },
      ],
    });

    await prisma.creatorState.createMany({
      data: [
        {
          wawuUserId: CREATOR_PAID_NO_KYC,
          kycStatus: 'pending',
          slotsUsed: 2,
          dmEnabled: true,
          dmPrice: 1500,
        },
        {
          wawuUserId: CREATOR_PAID_KYC_PENDING,
          kycStatus: 'pending',
          slotsUsed: 1,
        },
        {
          wawuUserId: CREATOR_PRO_DOWNGRADING,
          kycStatus: 'approved',
          slotsUsed: 4,
        },
        {
          wawuUserId: CREATOR_UNPAID,
          kycStatus: 'rejected',
          slotsUsed: 0,
        },
        // No UserProfile for this one, on purpose.
        {
          wawuUserId: ORPHANED_STATE,
          kycStatus: 'pending',
          slotsUsed: 0,
        },
      ],
    });

    // KYC: only the two accounts that have actually submitted. Document values
    // are real-shaped so the "never disclosed" assertion has something to fail on.
    await prisma.kycSubmission.createMany({
      data: [
        {
          wawuUserId: CREATOR_PAID_KYC_PENDING,
          country: 'NG',
          bvn: FIXTURE_BVN,
          nin: FIXTURE_NIN,
          idDocumentType: 'nin_slip',
          idDocumentUrl: FIXTURE_ID_DOC_URL,
          payoutBankName: FIXTURE_PAYOUT_BANK,
          payoutAccountNumber: FIXTURE_PAYOUT_ACCOUNT,
          status: 'pending',
          submittedAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          wawuUserId: CREATOR_UNPAID,
          country: 'NG',
          bvn: FIXTURE_BVN,
          nin: FIXTURE_NIN,
          idDocumentType: 'nin_slip',
          idDocumentUrl: FIXTURE_ID_DOC_URL,
          payoutBankName: FIXTURE_PAYOUT_BANK,
          payoutAccountNumber: FIXTURE_PAYOUT_ACCOUNT,
          status: 'rejected',
          rejectionReason: 'The uploaded document was unreadable.',
          submittedAt: new Date('2026-06-02T00:00:00.000Z'),
          reviewedAt: new Date('2026-06-03T00:00:00.000Z'),
        },
      ],
    });

    // Verification tier: a lower rung approved earlier, a higher rung approved
    // later, and a still-pending application above both — so "highest approved"
    // has to be a ladder comparison, not the newest row.
    await prisma.verificationSubmission.createMany({
      data: [
        {
          wawuUserId: CREATOR_PRO_DOWNGRADING,
          tier: 'verified_user',
          status: 'approved',
          documents: [],
          submittedAt: new Date('2026-01-10T00:00:00.000Z'),
          reviewedAt: new Date('2026-01-11T00:00:00.000Z'),
        },
        {
          wawuUserId: CREATOR_PRO_DOWNGRADING,
          tier: 'verified_business',
          status: 'approved',
          documents: [],
          submittedAt: new Date('2026-02-10T00:00:00.000Z'),
          reviewedAt: new Date('2026-02-11T00:00:00.000Z'),
        },
        {
          wawuUserId: CREATOR_PRO_DOWNGRADING,
          tier: 'certified_professional',
          status: 'pending',
          documents: [],
          submittedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
    });

    await prisma.contentPiece.createMany({
      data: [
        {
          id: PIECE_PENDING,
          creatorWawuId: CREATOR_PAID_NO_KYC,
          slug: 'admin-creators-contract-pending',
          title: 'Waiting on a moderator',
          description: 'Fixture for the admin creator-lookup contract suite.',
          category: 'admin-creators-contract',
          tags: [],
          contentType: 'video',
          accessType: 'free',
          price: 0,
          status: 'pending',
          previewAssetUrl: 'content/preview/b1000000/contract-fixture.jpg',
        },
        {
          id: PIECE_LIVE,
          creatorWawuId: CREATOR_PAID_NO_KYC,
          slug: 'admin-creators-contract-live',
          title: 'Already live',
          description: 'Fixture for the admin creator-lookup contract suite.',
          category: 'admin-creators-contract',
          tags: [],
          contentType: 'video',
          accessType: 'free',
          price: 0,
          status: 'live',
          previewAssetUrl: 'content/preview/b1000000/contract-fixture.jpg',
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

    userToken = await loginToWawuId(USER_PLAIN_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminCreatorsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
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
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, name: 'Creators Super', role: 'superadmin', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'Creators Support', role: 'support', passwordHash },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'Creators Finance', role: 'finance', passwordHash },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, name: 'Creators Reviewer', role: 'reviewer', passwordHash },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);

    await seedFixtures();
  }, 30000);

  afterAll(async () => {
    if (prisma) {
      await clearFixtures();
      await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    }
    await app?.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── GET /admin/creators ───────────────────────────────────────────────────

  describe('GET /api/hub/admin/creators', () => {
    const search = (token: string, query: Record<string, unknown> = {}) =>
      http()
        .get('/api/hub/admin/creators')
        .query({ perPage: 100, ...query })
        .set(auth(token));

    it('finds a creator by a PARTIAL, case-insensitive handle', async () => {
      // The stored handle is `…-AdaNoKyc`; the operator types what was in the
      // ticket.
      const res = await search(supportToken, { q: `${HANDLE_STEM}-adanokyc` }).expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      const ids: string[] = res.body.data.map((r: { wawuUserId: string }) => r.wawuUserId);
      expect(ids).toEqual([CREATOR_PAID_NO_KYC]);
    });

    it('finds every fixture from the shared handle stem', async () => {
      const res = await search(supportToken, { q: HANDLE_STEM }).expect(200);
      const ids: string[] = res.body.data.map((r: { wawuUserId: string }) => r.wawuUserId);
      for (const id of [
        CREATOR_PAID_NO_KYC,
        CREATOR_PAID_KYC_PENDING,
        CREATOR_PRO_DOWNGRADING,
        CREATOR_UNPAID,
        PLAIN_USER,
      ]) {
        expect(ids).toContain(id);
      }
    });

    it('finds a creator by a wawuUserId, whole or truncated', async () => {
      const whole = await search(supportToken, { q: CREATOR_PAID_NO_KYC }).expect(200);
      expect(whole.body.data.map((r: { wawuUserId: string }) => r.wawuUserId)).toEqual([
        CREATOR_PAID_NO_KYC,
      ]);

      // A wawuUserId is all digits once its dashes are stripped. It must not be
      // mistaken for a phone number and refused.
      const truncated = await search(supportToken, {
        q: CREATOR_PAID_NO_KYC.slice(0, 18),
      }).expect(200);
      expect(
        truncated.body.data.map((r: { wawuUserId: string }) => r.wawuUserId),
      ).toContain(CREATOR_PAID_NO_KYC);
    });

    it('does NOT default to accountType=creator — a payer whose account type never flipped is findable', async () => {
      const res = await search(supportToken, { q: `${HANDLE_STEM}-plainuser` }).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        wawuUserId: PLAIN_USER,
        accountType: 'user',
      });
    });

    it('reports the earning gate as its own field, and never as a merged boolean', async () => {
      const res = await search(supportToken, { q: HANDLE_STEM }).expect(200);
      const row = res.body.data.find(
        (r: { wawuUserId: string }) => r.wawuUserId === CREATOR_PAID_KYC_PENDING,
      );

      expect(row.gates).toMatchObject({ kycStatus: 'pending' });
      // The upload gate went with subscriptions. It must not come back as a
      // column that always says the same thing.
      expect(row.gates).not.toHaveProperty('subscriptionPaid');
      expect(row).not.toHaveProperty('tier');
      expect(JSON.stringify(res.body)).not.toContain('"verified"');
    });

    it("synthesises `not_started` for a creator who has never submitted KYC", async () => {
      const res = await search(supportToken, { q: HANDLE_STEM }).expect(200);
      const byId = (id: string) =>
        res.body.data.find((r: { wawuUserId: string }) => r.wawuUserId === id);

      // Both rows hold `kycStatus: 'pending'` in the column. Only one of them
      // is actually waiting on a reviewer.
      expect(byId(CREATOR_PAID_NO_KYC).gates.kycStatus).toBe('not_started');
      expect(byId(CREATOR_PAID_KYC_PENDING).gates.kycStatus).toBe('pending');
    });

    it('filters by the earning gate', async () => {
      const rejected = await search(supportToken, {
        q: HANDLE_STEM,
        kycStatus: 'rejected',
      }).expect(200);
      expect(rejected.body.data.map((r: { wawuUserId: string }) => r.wawuUserId)).toEqual([
        CREATOR_UNPAID,
      ]);
    });

    it('filters by the SYNTHESISED not_started state, not just the stored column', async () => {
      const res = await search(supportToken, {
        q: HANDLE_STEM,
        kycStatus: 'not_started',
      }).expect(200);
      const ids: string[] = res.body.data.map((r: { wawuUserId: string }) => r.wawuUserId);

      expect(ids).toContain(CREATOR_PAID_NO_KYC);
      // Same stored value, different real state. A filter that could not tell
      // them apart would put "chase the creator" and "chase a reviewer" in one
      // bucket.
      expect(ids).not.toContain(CREATOR_PAID_KYC_PENDING);
    });

    it('paginates and sorts', async () => {
      const first = await search(supportToken, {
        q: HANDLE_STEM,
        perPage: 2,
        page: 1,
        sort: 'oldest',
      }).expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.pagination).toMatchObject({ currentPage: 1, perPage: 2, total: 5 });
      expect(first.body.data[0].wawuUserId).toBe(CREATOR_PAID_NO_KYC);

      const second = await search(supportToken, {
        q: HANDLE_STEM,
        perPage: 2,
        page: 2,
        sort: 'oldest',
      }).expect(200);
      expect(second.body.data.map((r: { wawuUserId: string }) => r.wawuUserId)).toEqual([
        CREATOR_PRO_DOWNGRADING,
        CREATOR_UNPAID,
      ]);
    });

    // ── the honest-contract tests ───────────────────────────────────────────

    it('REFUSES an email search with an explanation, rather than returning "no results"', async () => {
      const res = await search(supportToken, { q: 'ada@example.com' }).expect(400);

      expect(res.body.message).toContain('cannot search by an email address');
      // The message has to name what DOES work, or the operator is stuck.
      expect(res.body.message).toContain('handle');
      expect(res.body.message).toContain('WAWU ID');
      expect(res.body.data).toBeNull();
    });

    it('REFUSES a phone search, in both the shapes a Nigerian number is typed', async () => {
      for (const q of ['+2348012345678', '08012345678', '0801 234 5678']) {
        const res = await search(supportToken, { q }).expect(400);
        expect(res.body.message).toContain('cannot search by a phone number');
      }
    });

    it('rejects an unknown query parameter (forbidNonWhitelisted)', async () => {
      await search(supportToken, { email: 'ada@example.com' }).expect(400);
    });

    it('is open to superadmin, support and finance; refused to reviewer and to a user token', async () => {
      await search(superToken, { q: HANDLE_STEM }).expect(200);
      await search(supportToken, { q: HANDLE_STEM }).expect(200);
      await search(financeToken, { q: HANDLE_STEM }).expect(200);
      await search(reviewerToken, { q: HANDLE_STEM }).expect(403);
      await search(userToken, { q: HANDLE_STEM }).expect(401);
      await http().get('/api/hub/admin/creators').expect(401);
    });
  });

  // ── GET /admin/creators/:wawuId ───────────────────────────────────────────

  describe('GET /api/hub/admin/creators/:wawuId', () => {
    const detail = (token: string, id: string) =>
      http().get(`/api/hub/admin/creators/${id}`).set(auth(token));

    it('answers "I paid and I cannot upload" in one response, as distinct fields', async () => {
      const res = await detail(supportToken, CREATOR_PAID_NO_KYC).expect(200);
      const data = res.body.data;

      expect(data).toMatchObject({
        wawuUserId: CREATOR_PAID_NO_KYC,
        handle: `${HANDLE_STEM}-AdaNoKyc`,
        accountType: 'creator',
      });

      // No subscription block at all: there is no subscription to report and
      // a block of nulls would read as one that failed to load.
      expect(data).not.toHaveProperty('subscription');

      // The earning gate, on its own.
      expect(data.gates).toMatchObject({
        kycStatus: 'not_started',
        kycSubmittedAt: null,
      });
      expect(data.gates).not.toHaveProperty('subscriptionPaid');

      // The badge, as its own field, and honest about who owns it.
      expect(data.verification).toEqual({
        approvedTier: null,
        approvedAt: null,
        pendingTier: null,
        authority: 'wawu-id',
      });

      // Slots. `slotsTotal` is derived, never stored, and flat per account.
      // There is no free/paid sub-split any more, so neither field is here.
      expect(data.uploads).toEqual({
        slotsUsed: 2,
        slotsTotal: 5,
        pendingReviewCount: 1,
        liveCount: 1,
      });

      // Earnings, from CreatorEarningsService — the same numbers the creator
      // sees on their own screen.
      expect(data.earnings).toEqual({ total: 0, payable: 0, held: 0 });

      expect(data.directMessages).toEqual({ enabled: true, price: 1500 });
    });

    it('derives the same flat slot total for every creator, whoever they are', async () => {
      const res = await detail(financeToken, CREATOR_PRO_DOWNGRADING).expect(200);
      // This creator used to be on a plan that bought more slots. There is
      // one number now, and it is the same one the previous test asserted.
      expect(res.body.data.uploads).toMatchObject({ slotsUsed: 4, slotsTotal: 5 });
    });

    it('reports the verification badge as the HIGHEST approved rung, kept apart from kycStatus', async () => {
      const res = await detail(supportToken, CREATOR_PRO_DOWNGRADING).expect(200);

      // verified_business was approved after verified_user, and a
      // certified_professional application is still in front of a reviewer.
      expect(res.body.data.verification).toEqual({
        approvedTier: 'verified_business',
        approvedAt: '2026-02-11T00:00:00.000Z',
        pendingTier: 'certified_professional',
        authority: 'wawu-id',
      });
      // The earning gate is a different system and a different field.
      expect(res.body.data.gates.kycStatus).toBe('approved');
    });

    it('carries the KYC dates and the reviewer\'s reason, and NOT one document value', async () => {
      const res = await detail(supportToken, CREATOR_UNPAID).expect(200);

      expect(res.body.data.gates).toMatchObject({
        kycStatus: 'rejected',
        kycSubmittedAt: '2026-06-02T00:00:00.000Z',
        kycReviewedAt: '2026-06-03T00:00:00.000Z',
        kycRejectionReason: 'The uploaded document was unreadable.',
      });

      // Support is refused KYC DOCUMENTS in ../kyc-review/. This surface must
      // not be a way around that.
      const body = JSON.stringify(res.body);
      for (const secret of [
        FIXTURE_BVN,
        FIXTURE_NIN,
        FIXTURE_PAYOUT_ACCOUNT,
        FIXTURE_PAYOUT_BANK,
        FIXTURE_ID_DOC_URL,
      ]) {
        expect(body).not.toContain(secret);
      }
    });

    it('never discloses a document value on the list endpoint either', async () => {
      const res = await http()
        .get('/api/hub/admin/creators')
        .query({ q: HANDLE_STEM, perPage: 100 })
        .set(auth(supportToken))
        .expect(200);

      const body = JSON.stringify(res.body);
      for (const secret of [FIXTURE_BVN, FIXTURE_NIN, FIXTURE_PAYOUT_ACCOUNT, FIXTURE_ID_DOC_URL]) {
        expect(body).not.toContain(secret);
      }
    });

    it('opens an account that has CreatorState but no UserProfile, rather than 404ing', async () => {
      // Every CreatorAccountGuard reads accountType off the profile, so this
      // shape 403s the account everywhere. It is exactly the ticket this
      // screen exists for.
      const res = await detail(superToken, ORPHANED_STATE).expect(200);
      expect(res.body.data).toMatchObject({
        wawuUserId: ORPHANED_STATE,
        handle: null,
        accountType: null,
        createdAt: null,
      });
      expect(res.body.data.gates.kycStatus).toBe('not_started');
    });

    it('reports a plain user honestly rather than inventing creator state', async () => {
      const res = await detail(supportToken, PLAIN_USER).expect(200);
      expect(res.body.data).toMatchObject({ accountType: 'user' });
      expect(res.body.data.gates).toEqual({
        kycStatus: null,
        kycSubmittedAt: null,
        kycReviewedAt: null,
        kycRejectionReason: null,
      });
      expect(res.body.data.uploads).toMatchObject({ slotsUsed: null, slotsTotal: null });
    });

    it('404s on an account this backend has never heard of', async () => {
      await detail(supportToken, UNKNOWN_USER).expect(404);
    });

    it('is open to superadmin, support and finance; refused to reviewer and to a user token', async () => {
      await detail(superToken, CREATOR_PAID_NO_KYC).expect(200);
      await detail(financeToken, CREATOR_PAID_NO_KYC).expect(200);
      await detail(reviewerToken, CREATOR_PAID_NO_KYC).expect(403);
      await detail(userToken, CREATOR_PAID_NO_KYC).expect(401);
      await http().get(`/api/hub/admin/creators/${CREATOR_PAID_NO_KYC}`).expect(401);
    });
  });
});
