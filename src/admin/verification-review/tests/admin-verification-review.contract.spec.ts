import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { VerificationSubmissionModule } from '../../../verification-submission/verification-submission.module';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminVerificationReviewModule } from '../admin-verification-review.module';

/**
 * Contract tests for the admin verification-tier review surface
 * (admin-surface-extension Phase 6).
 *
 * Two assertions carry this file.
 *
 * The first is that a decision lands where the applicant can see it: after a
 * rejection, the EXISTING `GET /api/hub/verification/submissions` — mounted
 * here from the real, unmodified VerificationSubmissionModule and driven with
 * a real RS256 WAWU ID token — reports it. Before this module existed nothing
 * could enumerate a pending submission, so no reviewer could discover an id
 * and nobody could ever be moved off the bottom rung.
 *
 * The second is that approving reaches WAWU ID. The badge tier is WAWU ID's
 * property, not this backend's; the existing service elevates it there BEFORE
 * writing the local approval, and this suite proves the tier actually changed
 * by logging in again and reading the fresh claim.
 *
 * Also proved here: the queue lists only pending work oldest-first, document
 * URLs are 900-second signatures that never land in the stored row, every
 * document fetch writes an audit row naming the admin, a rejection is refused
 * without a reason, support may read but not decide, finance is refused
 * outright, a WAWU ID user token cannot reach any of it — and nothing on this
 * surface touches the earning gate or says the word "KYC".
 *
 * Fixtures live under this suite's own `1e……` / `ae……` id prefixes and are
 * swept in afterAll (README § Test hygiene). The one seeded identity it
 * drives, creator-pro, has its WAWU ID tier captured live and restored.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/**
 * The mock's default internal service key. WawuIdClient reads it in its
 * constructor, so it has to be in process.env before ConfigModule compiles.
 */
const MOCK_INTERNAL_SERVICE_KEY =
  process.env.MOCK_WAWU_ID_INTERNAL_SERVICE_KEY ?? 'dev-internal-service-key-not-secret';

/** Seeded WAWU ID identities. mock-wawu-id keys its login on the email. */
const APPLICANT_KNOWN = '00000000-0000-4000-8000-000000000003';
const APPLICANT_KNOWN_EMAIL = 'creator-pro@test.wawu.dev';
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

/** A suite-owned applicant WAWU ID has never heard of — approving them would fail by design. */
const APPLICANT_UNKNOWN = '1e000000-0000-4000-8000-0000000000c2';

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'ae000000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'ae000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'ae000000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'ae000000-0000-4000-8000-000000000004';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_REVIEWER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID];

const SUPER_EMAIL = 'tier-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'tier-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'tier-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'tier-finance@admin.test.wawu.dev';
const PASSWORD = 'verification-review-contract-password';

const TEST_ACCESS_SECRET = 'admin-verification-access-secret-0123456789';
const TEST_REFRESH_SECRET = 'admin-verification-refresh-secret-0123456789';

// ── suite-owned submission fixtures ─────────────────────────────────────────
const SUB_PENDING_OLD = '1e000000-0000-4000-8000-000000000001';
const SUB_PENDING_NEW = '1e000000-0000-4000-8000-000000000002';
const SUB_APPROVED = '1e000000-0000-4000-8000-000000000003';
const SUB_IDS = [SUB_PENDING_OLD, SUB_PENDING_NEW, SUB_APPROVED];
const UNKNOWN_SUB = '1e000000-0000-4000-8000-0000000000ff';

const APPLICANT_IDS = [APPLICANT_UNKNOWN, APPLICANT_KNOWN];

/**
 * `documents` is a free-text String[] the client fills in, so both shapes are
 * real: a bare object key that can be signed, and an absolute URL that
 * StorageService returns verbatim. The surface has to report the difference
 * rather than promise 900 seconds over a permanent link.
 */
const DOC_STORED_KEY =
  'verification/business-registration/1e000000-0000-4000-8000-0000000000c2/cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa.pdf';
const DOC_STORED_LEGACY_URL = 'https://storage.seed.local/verification/legacy-certificate.pdf';

/** The elevated tier this suite applies, and restores from, at WAWU ID. */
const TIER_APPLIED_FOR = 'verified_business' as const;

async function loginToWawuId(identifier: string): Promise<{ accessToken: string; verificationTier: string }> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string; user: { verificationTier: string } };
  return { accessToken: body.accessToken, verificationTier: body.user.verificationTier };
}

async function setWawuIdTier(sub: string, tier: string): Promise<Response> {
  return fetch(`${MOCK_WAWU_ID_URL}/internal/users/${sub}/verification-tier`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': MOCK_INTERNAL_SERVICE_KEY },
    body: JSON.stringify({ tier }),
  });
}

/**
 * A real, JWKS-verifiable WAWU ID token for a sub that is not a seeded mock
 * user — the same technique verification-submission's own contract spec uses.
 * Needed so the applicant-facing assertion can call the app's existing
 * endpoint AS the applicant whose submission was just decided.
 */
async function mintTokenFor(sub: string): Promise<string> {
  const jwt = await import('jsonwebtoken');
  const fs = await import('fs');
  const path = await import('path');
  const privateKey = fs.readFileSync(path.join(__dirname, '../../../../mock-wawu-id/private.pem'), 'utf8');
  return jwt.sign(
    {
      sub,
      email: `${sub}@test.wawu.dev`,
      phone: '+2348000009922',
      firstName: 'Contract',
      lastName: 'Applicant',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
      platformRefs: { wawuafricaAppUserId: sub },
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

describe('Admin verification review contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superToken: string;
  let reviewerToken: string;
  let supportToken: string;
  let financeToken: string;
  let userToken: string;
  let unknownApplicantToken: string;

  /**
   * The mock WAWU ID service is a shared, long-lived process — its in-memory
   * tier for a seeded user persists across test RUNS, not just within one.
   * Capture live, never hardcode, and restore in afterAll so a rerun of this
   * suite (and anything else that reads this identity) sees a stable value.
   */
  let knownApplicantStartingTier: string;

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

  async function resetSubmissionFixtures(): Promise<void> {
    await prisma.adminVerificationAudit.deleteMany({ where: { submissionId: { in: SUB_IDS } } });
    await prisma.verificationSubmission.deleteMany({ where: { wawuUserId: { in: APPLICANT_IDS } } });
    await prisma.verificationSubmission.createMany({
      data: [
        {
          id: SUB_PENDING_OLD,
          wawuUserId: APPLICANT_UNKNOWN,
          tier: TIER_APPLIED_FOR,
          status: 'pending',
          documents: [DOC_STORED_KEY, DOC_STORED_LEGACY_URL],
          submittedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: SUB_PENDING_NEW,
          wawuUserId: APPLICANT_KNOWN,
          tier: TIER_APPLIED_FOR,
          status: 'pending',
          documents: [DOC_STORED_KEY],
          submittedAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          id: SUB_APPROVED,
          wawuUserId: APPLICANT_UNKNOWN,
          tier: 'verified_user',
          status: 'approved',
          documents: [DOC_STORED_KEY],
          submittedAt: new Date('2025-12-01T00:00:00.000Z'),
          reviewedAt: new Date('2025-12-02T00:00:00.000Z'),
        },
      ],
    });
  }

  beforeAll(async () => {
    for (const key of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'WAWU_ID_INTERNAL_SERVICE_KEY',
      'WAWU_ID_BASE_URL',
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
    // WawuIdClient reads both in its constructor, and @nestjs/config never
    // overwrites a variable already in process.env — so setting them here wins
    // over the `.env` values meant for the real WAWU ID service.
    process.env.WAWU_ID_INTERNAL_SERVICE_KEY = MOCK_INTERNAL_SERVICE_KEY;
    process.env.WAWU_ID_BASE_URL = MOCK_WAWU_ID_URL;
    // Presigning is pure local crypto — no network, no real bucket. These
    // credentials exist only so StorageService is CONFIGURED, which is what
    // lets the suite assert the URL is actually short-lived, not just non-null.
    process.env.STORAGE_ENDPOINT = 'https://bucket.example-storage.dev';
    process.env.STORAGE_ACCESS_KEY_ID = 'contract-test-key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'contract-test-secret';
    process.env.STORAGE_BUCKET = 'contract-test-bucket';
    process.env.STORAGE_REGION = 'auto';

    userToken = (await loginToWawuId(USER_PLAIN_EMAIL)).accessToken;
    knownApplicantStartingTier = (await loginToWawuId(APPLICANT_KNOWN_EMAIL)).verificationTier;
    unknownApplicantToken = await mintTokenFor(APPLICANT_UNKNOWN);

    // Fail with the actual reason if the mock rejects our key, rather than
    // letting it surface later as an unexplained 500 from the approval test.
    // Writes back the tier just read, so the probe itself changes nothing.
    const preflight = await setWawuIdTier(APPLICANT_KNOWN, knownApplicantStartingTier);
    if (!preflight.ok) {
      throw new Error(
        `mock-wawu-id rejected the internal service key (${preflight.status}). ` +
          'Start the mock with the default dev key, or set ' +
          'MOCK_WAWU_ID_INTERNAL_SERVICE_KEY to the key it is using.',
      );
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminVerificationReviewModule,
        // The REAL applicant-facing routes, unmodified, so a decision can be
        // proved against what the applicant actually calls. Registered after
        // the admin module, mirroring app.module.ts.
        VerificationSubmissionModule,
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
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, name: 'Tier Super', role: 'superadmin', passwordHash },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, name: 'Tier Reviewer', role: 'reviewer', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'Tier Support', role: 'support', passwordHash },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'Tier Finance', role: 'finance', passwordHash },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
  });

  beforeEach(async () => {
    await resetSubmissionFixtures();
  });

  afterAll(async () => {
    await prisma.adminVerificationAudit.deleteMany({ where: { submissionId: { in: SUB_IDS } } });
    await prisma.verificationSubmission.deleteMany({ where: { wawuUserId: { in: APPLICANT_IDS } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await app.close();
    // Put the shared mock's tier back for the seeded identity this suite drove.
    await setWawuIdTier(APPLICANT_KNOWN, knownApplicantStartingTier);
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── GET /admin/verification/queue ─────────────────────────────────────────

  describe('GET /api/hub/admin/verification/queue', () => {
    it('lists ONLY pending submissions, oldest first, in the standard envelope', async () => {
      const res = await http()
        .get('/api/hub/admin/verification/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.pagination).toMatchObject({ currentPage: 1, perPage: 100 });

      const ids: string[] = res.body.data.map((i: { id: string }) => i.id);
      expect(ids).toContain(SUB_PENDING_OLD);
      expect(ids).toContain(SUB_PENDING_NEW);
      expect(ids).not.toContain(SUB_APPROVED);
      expect(res.body.data.every((i: { status: string }) => i.status === 'pending')).toBe(true);
      expect(ids.indexOf(SUB_PENDING_OLD)).toBeLessThan(ids.indexOf(SUB_PENDING_NEW));
    });

    it('honours ?sort=newest and ?tier=', async () => {
      const newest = await http()
        .get('/api/hub/admin/verification/queue')
        .query({ perPage: 100, sort: 'newest' })
        .set(auth(reviewerToken))
        .expect(200);
      const ids: string[] = newest.body.data.map((i: { id: string }) => i.id);
      expect(ids.indexOf(SUB_PENDING_NEW)).toBeLessThan(ids.indexOf(SUB_PENDING_OLD));

      const filtered = await http()
        .get('/api/hub/admin/verification/queue')
        .query({ perPage: 100, tier: 'certified_professional' })
        .set(auth(reviewerToken))
        .expect(200);
      expect(filtered.body.data.map((i: { id: string }) => i.id)).not.toContain(SUB_PENDING_OLD);
    });

    it('carries the applicant and the rung, and never the raw stored document values', async () => {
      const res = await http()
        .get('/api/hub/admin/verification/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const item = res.body.data.find((i: { id: string }) => i.id === SUB_PENDING_OLD);
      expect(item).toMatchObject({
        tier: TIER_APPLIED_FOR,
        status: 'pending',
        documentCount: 2,
        applicant: { wawuUserId: APPLICANT_UNKNOWN },
      });
      expect(item.waitingHours).toBeGreaterThan(0);

      // The only way to reach a document is the audited signed-URL endpoint.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(DOC_STORED_LEGACY_URL);
      expect(body).not.toContain(DOC_STORED_KEY);
    });

    it('400s on an unknown query property, an out-of-range perPage, and an invalid tier', async () => {
      await http()
        .get('/api/hub/admin/verification/queue')
        .query({ status: 'approved' })
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .get('/api/hub/admin/verification/queue')
        .query({ perPage: 500 })
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .get('/api/hub/admin/verification/queue')
        .query({ tier: 'platinum' })
        .set(auth(reviewerToken))
        .expect(400);
    });
  });

  // ── GET /admin/verification/:id ───────────────────────────────────────────

  describe('GET /api/hub/admin/verification/:id', () => {
    it('describes each document by index and filename, with history and an empty audit trail', async () => {
      const res = await http()
        .get(`/api/hub/admin/verification/${SUB_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body.data).toMatchObject({ id: SUB_PENDING_OLD, tier: TIER_APPLIED_FOR, status: 'pending' });
      expect(res.body.data.documents).toEqual([
        { index: 0, filename: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa.pdf' },
        { index: 1, filename: 'legacy-certificate.pdf' },
      ]);

      // Both of this applicant's filings, newest first.
      expect(res.body.data.history.map((h: { id: string }) => h.id)).toEqual([
        SUB_PENDING_OLD,
        SUB_APPROVED,
      ]);
      expect(res.body.data.auditTrail).toEqual([]);
    });

    it('reaches a submission at any status, so a reviewer can revisit a decision', async () => {
      await http()
        .get(`/api/hub/admin/verification/${SUB_APPROVED}`)
        .set(auth(reviewerToken))
        .expect(200);
    });

    it('404s an unknown id and 400s a non-uuid id', async () => {
      const res = await http()
        .get(`/api/hub/admin/verification/${UNKNOWN_SUB}`)
        .set(auth(reviewerToken))
        .expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Verification submission not found',
        data: null,
      });
      await http().get('/api/hub/admin/verification/not-a-uuid').set(auth(reviewerToken)).expect(400);
    });
  });

  // ── POST /admin/verification/:id/document-url ─────────────────────────────

  describe('POST /api/hub/admin/verification/:id/document-url', () => {
    it('hands back a 900-SECOND signed URL and audits which document was opened', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .send({ documentIndex: 0 })
        .expect(200);

      expect(res.body.data).toMatchObject({ index: 0, signed: true, expiresInSeconds: 900 });
      const url: string = res.body.data.url;
      expect(url).toContain('X-Amz-Expires=900');
      expect(url).not.toContain('X-Amz-Expires=604800');
      expect(res.body.data.audit).toMatchObject({
        action: 'document_viewed',
        documentIndex: 0,
        previousStatus: null,
        newStatus: null,
        tierElevatedAtWawuId: false,
        actedByAdminId: ADMIN_REVIEWER_ID,
        actedByAdminEmail: REVIEWER_EMAIL,
        actedByAdminRole: 'reviewer',
      });

      // The stored array is untouched, and the trail records THAT a fetch
      // happened, never the means to repeat it.
      const row = await prisma.verificationSubmission.findUniqueOrThrow({ where: { id: SUB_PENDING_OLD } });
      expect(row.documents).toEqual([DOC_STORED_KEY, DOC_STORED_LEGACY_URL]);
      const audits = await prisma.adminVerificationAudit.findMany({
        where: { submissionId: SUB_PENDING_OLD },
      });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain('X-Amz-Signature');
    });

    it('says so honestly when the stored value is an absolute URL that cannot be signed', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .send({ documentIndex: 1 })
        .expect(200);

      expect(res.body.data).toMatchObject({
        index: 1,
        signed: false,
        expiresInSeconds: null,
        expiresAt: null,
        url: DOC_STORED_LEGACY_URL,
      });
    });

    it('400s an index the submission does not have, and 400s a missing index', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .send({ documentIndex: 5 })
        .expect(400);
      expect(res.body.message).toBe(
        'This submission has 2 document(s); there is no document 5.',
      );

      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .send({})
        .expect(400);
    });
  });

  // ── POST /admin/verification/:id/approve ──────────────────────────────────

  describe('POST /api/hub/admin/verification/:id/approve', () => {
    it('elevates the tier at WAWU ID, which owns it, and audits that it landed', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_NEW}/approve`)
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body.data.submission).toMatchObject({ id: SUB_PENDING_NEW, status: 'approved' });
      expect(res.body.data.audit).toMatchObject({
        action: 'approved',
        previousStatus: 'pending',
        newStatus: 'approved',
        tierElevatedAtWawuId: true,
        reason: null,
        actedByAdminId: ADMIN_REVIEWER_ID,
      });

      // Proof the badge actually moved at the identity service — a real HTTP
      // round trip, not a locally cached flag.
      const fresh = await loginToWawuId(APPLICANT_KNOWN_EMAIL);
      expect(fresh.verificationTier).toBe(TIER_APPLIED_FOR);

      const rows = await prisma.adminVerificationAudit.findMany({
        where: { submissionId: SUB_PENDING_NEW },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subjectWawuUserId: APPLICANT_KNOWN,
        tier: TIER_APPLIED_FOR,
        action: 'approved',
        tierElevatedAtWawuId: true,
      });
    });

    it('does NOT touch the earning gate — a badge is not a payout clearance', async () => {
      const before = await prisma.creatorState.findUnique({ where: { wawuUserId: APPLICANT_KNOWN } });

      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_NEW}/approve`)
        .set(auth(superToken))
        .expect(200);

      const after = await prisma.creatorState.findUnique({ where: { wawuUserId: APPLICANT_KNOWN } });
      // CLAUDE.md: two independent gates. Approving a public trust badge must
      // leave kycStatus, subscriptionPaid and tier exactly where they were.
      expect(after?.kycStatus).toBe(before?.kycStatus);
      expect(after?.subscriptionPaid).toBe(before?.subscriptionPaid);
      expect(after?.tier).toBe(before?.tier);
    });

    it('400s a submission that is not pending, without calling WAWU ID or writing an audit row', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_APPROVED}/approve`)
        .set(auth(reviewerToken))
        .expect(400);
      expect(res.body.message).toBe('Only a pending submission can be reviewed');
      expect(await prisma.adminVerificationAudit.count({ where: { submissionId: SUB_APPROVED } })).toBe(0);
    });

    it('404s an unknown id', async () => {
      await http()
        .post(`/api/hub/admin/verification/${UNKNOWN_SUB}/approve`)
        .set(auth(reviewerToken))
        .expect(404);
    });
  });

  // ── POST /admin/verification/:id/reject ───────────────────────────────────

  describe('POST /api/hub/admin/verification/:id/reject', () => {
    it('requires a reason', async () => {
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({})
        .expect(400);

      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: '   ' })
        .expect(400);
      expect(res.body.message).toBe('reason is required — the applicant is shown it.');

      const row = await prisma.verificationSubmission.findUniqueOrThrow({ where: { id: SUB_PENDING_OLD } });
      expect(row.status).toBe('pending');
      expect(await prisma.adminVerificationAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(0);
    });

    it('400s a reason longer than 1000 characters', async () => {
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'x'.repeat(1001) })
        .expect(400);
    });

    it('lands on the applicant’s OWN existing endpoint, with the reason they must act on', async () => {
      const reason = 'The business registration certificate has expired.';
      const res = await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason })
        .expect(200);

      expect(res.body.data.submission).toMatchObject({ status: 'rejected', rejectionReason: reason });
      expect(res.body.data.audit).toMatchObject({
        action: 'rejected',
        previousStatus: 'pending',
        newStatus: 'rejected',
        reason,
        tierElevatedAtWawuId: false,
      });

      // The unmodified applicant-facing route, driven with the applicant's own
      // token. Before this module existed, no reviewer could ever reach the
      // decision that puts this here.
      const mine = await http()
        .get('/api/hub/verification/submissions')
        .set(auth(unknownApplicantToken))
        .expect(200);
      const seen = (mine.body.data as Array<{ id: string; status: string; rejectionReason: string }>).find(
        (s) => s.id === SUB_PENDING_OLD,
      );
      expect(seen).toMatchObject({ status: 'rejected', rejectionReason: reason });
    });

    it('refuses a second decision on the same submission — one audit row', async () => {
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'First and only decision.' })
        .expect(200);
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Second attempt.' })
        .expect(400);
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(400);

      expect(await prisma.adminVerificationAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(1);
    });
  });

  // ── auth + role matrix ────────────────────────────────────────────────────

  describe('who may reach this surface', () => {
    /** Built lazily: supertest binds a fresh ephemeral listener per call. */
    const readRoutes = (token?: string): Array<() => request.Test> => {
      const withAuth = (r: request.Test) => (token ? r.set(auth(token)) : r);
      return [
        () => withAuth(http().get('/api/hub/admin/verification/queue')),
        () => withAuth(http().get(`/api/hub/admin/verification/${SUB_PENDING_OLD}`)),
      ];
    };
    const writeRoutes = (token?: string): Array<() => request.Test> => {
      const withAuth = (r: request.Test) => (token ? r.set(auth(token)) : r);
      return [
        () =>
          withAuth(
            http()
              .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/document-url`)
              .send({ documentIndex: 0 }),
          ),
        () => withAuth(http().post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/approve`)),
        () =>
          withAuth(
            http().post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`).send({ reason: 'no' }),
          ),
      ];
    };

    it('refuses an unauthenticated request on every route', async () => {
      for (const call of [...readRoutes(), ...writeRoutes()]) {
        await call().expect(401);
      }
    });

    it('refuses a valid WAWU ID USER token — an app user cannot review the ladder', async () => {
      for (const call of [...readRoutes(userToken), ...writeRoutes(userToken)]) {
        await call().expect(401);
      }
      const row = await prisma.verificationSubmission.findUniqueOrThrow({ where: { id: SUB_PENDING_OLD } });
      expect(row.status).toBe('pending');
    });

    /**
     * Support CAN read here and cannot read KYC at all. The difference is what
     * the row holds: a tier, a status and document references disclose nothing
     * about the person, where a KycSubmission is a BVN, a NIN and a bank
     * account. Opening a document is still a reviewer's act.
     */
    it('lets SUPPORT read the queue and the detail, but not fetch a document or decide', async () => {
      for (const call of readRoutes(supportToken)) {
        await call().expect(200);
      }
      for (const call of writeRoutes(supportToken)) {
        const res = await call().expect(403);
        expect(res.body.message).toBe('This action is not available to your admin role.');
      }
      expect(await prisma.adminVerificationAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(0);
    });

    it('refuses FINANCE outright — there is no money on this ladder', async () => {
      for (const call of [...readRoutes(financeToken), ...writeRoutes(financeToken)]) {
        await call().expect(403);
      }
    });

    it('lets superadmin and reviewer decide', async () => {
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_OLD}/reject`)
        .set(auth(superToken))
        .send({ reason: 'Superadmin decision.' })
        .expect(200);
      await http()
        .post(`/api/hub/admin/verification/${SUB_PENDING_NEW}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Reviewer decision.' })
        .expect(200);
    });

    it('refuses a suspended admin mid-session', async () => {
      await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { status: 'suspended' } });
      try {
        await http().get('/api/hub/admin/verification/queue').set(auth(reviewerToken)).expect(401);
      } finally {
        await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { status: 'active' } });
      }
    });
  });

  // ── the two gates stay apart ──────────────────────────────────────────────

  it('never mentions KYC, payout or earning anywhere in its responses', async () => {
    const queue = await http()
      .get('/api/hub/admin/verification/queue')
      .query({ perPage: 100 })
      .set(auth(reviewerToken))
      .expect(200);
    const detail = await http()
      .get(`/api/hub/admin/verification/${SUB_PENDING_OLD}`)
      .set(auth(reviewerToken))
      .expect(200);

    // The verification ladder is a public trust badge; KYC is the earning
    // gate. The app has already shipped copy describing "Government ID
    // submitted and approved by hand" on a rung of this ladder — no field of
    // one may appear on the other.
    for (const body of [JSON.stringify(queue.body).toLowerCase(), JSON.stringify(detail.body).toLowerCase()]) {
      expect(body).not.toContain('kyc');
      expect(body).not.toContain('bvn');
      expect(body).not.toContain('payout');
      expect(body).not.toContain('subscriptionpaid');
    }
  });
});
