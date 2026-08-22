import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { CreatorStateModule } from '../../../creator-state/creator-state.module';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminKycReviewModule } from '../admin-kyc-review.module';

/**
 * Contract tests for the admin KYC-review surface
 * (admin-surface-extension Phase 6).
 *
 * The load-bearing assertion in this file is not that a column changed. It is
 * that approving a submission makes the EXISTING `GET /api/hub/creator/state`
 * — mounted here from the real, unmodified CreatorStateModule and driven with
 * a real RS256 WAWU ID token for the creator in question — report
 * `kycStatus: 'approved'`. That endpoint is the earning gate as the creator
 * and the rest of the product see it. Before this module existed, its only
 * writer of `approved` sat behind `POST /kyc/:id/review`, a route nothing
 * could enumerate a submission id for, so no creator on this platform could
 * ever be cleared to be paid. Asserting the column would prove nothing about
 * that; asserting the creator's own endpoint is the whole point.
 *
 * Also proved here: the queue lists only pending work oldest-first, identifiers
 * are masked everywhere except the audited reveal, a document URL is a
 * 900-second signature and never lands in the stored row, every document fetch
 * and unmask writes an audit row naming the admin, a rejection is refused
 * without a reason, support and finance cannot reach this resource at all, and
 * a WAWU ID user token cannot either.
 *
 * Fixtures live under this suite's own `1d……` / `ad……` id prefixes and are
 * swept in afterAll (README § Test hygiene). No seeded row is mutated.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded plain (non-creator) WAWU ID user. mock-wawu-id keys its login on the email. */
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'ad000000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'ad000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'ad000000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'ad000000-0000-4000-8000-000000000004';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_REVIEWER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID];

const SUPER_EMAIL = 'kyc-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'kyc-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'kyc-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'kyc-finance@admin.test.wawu.dev';
const PASSWORD = 'kyc-review-contract-password';

const TEST_ACCESS_SECRET = 'admin-kyc-review-access-secret-0123456789';
const TEST_REFRESH_SECRET = 'admin-kyc-review-refresh-secret-0123456789';

// ── suite-owned KYC fixtures ────────────────────────────────────────────────
/** A creator who has been rejected once and has resubmitted. */
const CREATOR_RESUBMITTING = '1d000000-0000-4000-8000-0000000000c1';
/** A creator filing for the first time, whose document is a legacy absolute URL. */
const CREATOR_FIRST_TIME = '1d000000-0000-4000-8000-0000000000c2';
const CREATOR_IDS = [CREATOR_RESUBMITTING, CREATOR_FIRST_TIME];

const SUB_REJECTED = '1d000000-0000-4000-8000-000000000001';
const SUB_PENDING_OLD = '1d000000-0000-4000-8000-000000000002';
const SUB_PENDING_NEW = '1d000000-0000-4000-8000-000000000003';
const SUB_IDS = [SUB_REJECTED, SUB_PENDING_OLD, SUB_PENDING_NEW];
const UNKNOWN_SUB = '1d000000-0000-4000-8000-0000000000ff';

const STARTING_SLOTS = 2;

/**
 * The two shapes `idDocumentUrl` actually holds. The protected registry
 * records a bare object key as the current shape; the seed script writes an
 * absolute URL, and StorageService returns those verbatim rather than signing
 * them. Both have to be handled, and the difference has to be reported rather
 * than papered over.
 */
const DOC_STORED_KEY = `kyc/id-document/${CREATOR_RESUBMITTING}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`;
const DOC_STORED_LEGACY_URL = 'https://storage.seed.local/kyc/legacy-nin-slip.pdf';

const BVN = '22212345671';
const NIN = '11198765431';
const ACCOUNT_NUMBER = '0123456781';
const MASKED_BVN = '•••••••5671';
const MASKED_NIN = '•••••••5431';
const MASKED_ACCOUNT = '••••••6781';

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

/**
 * A real, JWKS-verifiable WAWU ID token for a sub that is not a seeded mock
 * user — the same technique verification-submission's and credits-state's
 * contract specs use. Needed because the earning-gate assertion has to call
 * `GET /creator/state` AS the creator whose submission was just approved, and
 * that creator is a fixture of this suite, not one of the three seeded
 * identities.
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
      phone: '+2348000009911',
      firstName: 'Contract',
      lastName: 'Creator',
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

describe('Admin KYC review contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superToken: string;
  let reviewerToken: string;
  let supportToken: string;
  let financeToken: string;
  let userToken: string;
  let resubmittingCreatorToken: string;

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

  /** The creator's own view of their earning gate, through the real, unmodified endpoint. */
  async function creatorStateKycStatus(token: string): Promise<string> {
    const res = await http().get('/api/hub/creator/state').set(auth(token)).expect(200);
    return res.body.data.kycStatus as string;
  }

  /**
   * Puts every fixture back at its starting state. Run before each test
   * because the decision endpoints are the thing under test and they mutate
   * both the submission and the creator's gate.
   */
  async function resetKycFixtures(): Promise<void> {
    await prisma.adminKycAudit.deleteMany({ where: { submissionId: { in: SUB_IDS } } });
    await prisma.kycSubmission.deleteMany({ where: { wawuUserId: { in: CREATOR_IDS } } });

    for (const wawuUserId of CREATOR_IDS) {
      await prisma.creatorState.upsert({
        where: { wawuUserId },
        update: { kycStatus: 'pending', subscriptionPaid: true, tier: 'basic', slotsUsed: STARTING_SLOTS },
        create: {
          wawuUserId,
          tier: 'basic',
          subscriptionPaid: true,
          kycStatus: 'pending',
          slotsUsed: STARTING_SLOTS,
        },
      });
      await prisma.userProfile.upsert({
        where: { wawuUserId },
        update: { accountType: 'creator' },
        create: {
          wawuUserId,
          accountType: 'creator',
          handle: `contract-kyc-${wawuUserId.slice(-2)}`,
          interests: [],
        },
      });
    }

    await prisma.kycSubmission.createMany({
      data: [
        {
          id: SUB_REJECTED,
          wawuUserId: CREATOR_RESUBMITTING,
          country: 'Nigeria',
          bvn: BVN,
          nin: NIN,
          nationalIdEquivalent: null,
          idDocumentType: 'nin_slip',
          idDocumentUrl: DOC_STORED_KEY,
          payoutBankName: 'GTBank',
          payoutAccountNumber: ACCOUNT_NUMBER,
          status: 'rejected',
          rejectionReason: 'The ID photo was too dark to read.',
          submittedAt: new Date('2026-01-01T00:00:00.000Z'),
          reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
        {
          id: SUB_PENDING_OLD,
          wawuUserId: CREATOR_RESUBMITTING,
          country: 'Nigeria',
          bvn: BVN,
          nin: NIN,
          nationalIdEquivalent: null,
          idDocumentType: 'national_id_card',
          idDocumentUrl: DOC_STORED_KEY,
          payoutBankName: 'GTBank',
          payoutAccountNumber: ACCOUNT_NUMBER,
          status: 'pending',
          submittedAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        {
          id: SUB_PENDING_NEW,
          wawuUserId: CREATOR_FIRST_TIME,
          country: 'Kenya',
          bvn: null,
          nin: null,
          nationalIdEquivalent: 'KE-99887766',
          idDocumentType: 'passport',
          idDocumentUrl: DOC_STORED_LEGACY_URL,
          payoutBankName: 'Access Bank',
          payoutAccountNumber: '0098765431',
          status: 'pending',
          submittedAt: new Date('2026-06-01T00:00:00.000Z'),
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
    resubmittingCreatorToken = await mintTokenFor(CREATOR_RESUBMITTING);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminKycReviewModule,
        // The REAL earning gate as the product reads it, unmodified, so
        // "approved" can be proved against the creator's own endpoint rather
        // than against a column.
        WawuAuthModule,
        CreatorStateModule,
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
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, name: 'KYC Super', role: 'superadmin', passwordHash },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, name: 'KYC Reviewer', role: 'reviewer', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'KYC Support', role: 'support', passwordHash },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'KYC Finance', role: 'finance', passwordHash },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
  });

  beforeEach(async () => {
    await resetKycFixtures();
  });

  afterAll(async () => {
    await prisma.adminKycAudit.deleteMany({ where: { submissionId: { in: SUB_IDS } } });
    await prisma.kycSubmission.deleteMany({ where: { wawuUserId: { in: CREATOR_IDS } } });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: { in: CREATOR_IDS } } });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: CREATOR_IDS } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── GET /admin/kyc/queue ──────────────────────────────────────────────────

  describe('GET /api/hub/admin/kyc/queue', () => {
    it('lists ONLY pending submissions, oldest first, in the standard envelope', async () => {
      const res = await http()
        .get('/api/hub/admin/kyc/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.pagination).toMatchObject({ currentPage: 1, perPage: 100 });

      const ids: string[] = res.body.data.map((i: { id: string }) => i.id);
      expect(ids).toContain(SUB_PENDING_OLD);
      expect(ids).toContain(SUB_PENDING_NEW);
      expect(ids).not.toContain(SUB_REJECTED);
      expect(res.body.data.every((i: { status: string }) => i.status === 'pending')).toBe(true);

      // Oldest first is the default and the whole point: a creator cannot be
      // paid until someone clears them.
      expect(ids.indexOf(SUB_PENDING_OLD)).toBeLessThan(ids.indexOf(SUB_PENDING_NEW));
    });

    it('honours ?sort=newest', async () => {
      const res = await http()
        .get('/api/hub/admin/kyc/queue')
        .query({ perPage: 100, sort: 'newest' })
        .set(auth(reviewerToken))
        .expect(200);
      const ids: string[] = res.body.data.map((i: { id: string }) => i.id);
      expect(ids.indexOf(SUB_PENDING_NEW)).toBeLessThan(ids.indexOf(SUB_PENDING_OLD));
    });

    it('carries the evidence a reviewer needs, with identifiers MASKED and no document URL', async () => {
      const res = await http()
        .get('/api/hub/admin/kyc/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const item = res.body.data.find((i: { id: string }) => i.id === SUB_PENDING_OLD);
      expect(item).toMatchObject({
        wawuUserId: CREATOR_RESUBMITTING,
        handle: 'contract-kyc-c1',
        country: 'Nigeria',
        idDocumentType: 'national_id_card',
        hasIdDocument: true,
        idDocumentFilename: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf',
        payoutBankName: 'GTBank',
        status: 'pending',
      });
      expect(item.waitingHours).toBeGreaterThan(0);

      // Masked, and named so a client cannot mistake one for the other.
      expect(item.identifiers).toEqual({
        bvnMasked: MASKED_BVN,
        ninMasked: MASKED_NIN,
        nationalIdEquivalentMasked: null,
        payoutAccountNumberMasked: MASKED_ACCOUNT,
      });

      // The full values never appear anywhere in the list response, and
      // neither does anything that could fetch the government ID.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(BVN);
      expect(body).not.toContain(NIN);
      expect(body).not.toContain(ACCOUNT_NUMBER);
      expect(body).not.toContain('idDocumentUrl');
      expect(body).not.toContain('X-Amz-Signature');
    });

    it('marks a resubmission, so a third filing does not read like a first', async () => {
      const res = await http()
        .get('/api/hub/admin/kyc/queue')
        .query({ perPage: 100 })
        .set(auth(reviewerToken))
        .expect(200);

      const resubmitted = res.body.data.find((i: { id: string }) => i.id === SUB_PENDING_OLD);
      expect(resubmitted).toMatchObject({ submissionNumber: 2, isResubmission: true });

      const firstTime = res.body.data.find((i: { id: string }) => i.id === SUB_PENDING_NEW);
      expect(firstTime).toMatchObject({ submissionNumber: 1, isResubmission: false });
    });

    it('400s on an unknown query property and on an out-of-range perPage', async () => {
      await http()
        .get('/api/hub/admin/kyc/queue')
        .query({ status: 'approved' })
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .get('/api/hub/admin/kyc/queue')
        .query({ perPage: 500 })
        .set(auth(reviewerToken))
        .expect(400);
    });
  });

  // ── GET /admin/kyc/:id ────────────────────────────────────────────────────

  describe('GET /api/hub/admin/kyc/:id', () => {
    it('returns the creator gate state, the submission history and an empty audit trail', async () => {
      const res = await http()
        .get(`/api/hub/admin/kyc/${SUB_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body.data).toMatchObject({ id: SUB_PENDING_OLD, status: 'pending' });
      expect(res.body.data.creator).toMatchObject({
        wawuUserId: CREATOR_RESUBMITTING,
        handle: 'contract-kyc-c1',
        accountType: 'creator',
        tier: 'basic',
        // GATE 1 is shown for context and never written by this surface.
        subscriptionPaid: true,
        // GATE 2, as the creator's own screen words it.
        kycStatus: 'pending',
        slotsUsed: STARTING_SLOTS,
        // Derived with the same uploadAllowanceFor() the app uses — never a
        // second definition (law 13). basic = 6.
        slotsTotal: 6,
      });

      // Both filings, newest first, so the reviewer can read the earlier
      // rejection before deciding.
      expect(res.body.data.history.map((h: { id: string }) => h.id)).toEqual([
        SUB_PENDING_OLD,
        SUB_REJECTED,
      ]);
      expect(res.body.data.history[1]).toMatchObject({
        status: 'rejected',
        rejectionReason: 'The ID photo was too dark to read.',
      });

      expect(res.body.data.auditTrail).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(BVN);
    });

    it('reaches a submission at any status, so a reviewer can revisit a decision', async () => {
      await http().get(`/api/hub/admin/kyc/${SUB_REJECTED}`).set(auth(reviewerToken)).expect(200);
    });

    it('404s an unknown id and 400s a non-uuid id', async () => {
      const res = await http().get(`/api/hub/admin/kyc/${UNKNOWN_SUB}`).set(auth(reviewerToken)).expect(404);
      expect(res.body).toEqual({ statusCode: 404, message: 'KYC submission not found', data: null });
      await http().get('/api/hub/admin/kyc/not-a-uuid').set(auth(reviewerToken)).expect(400);
    });
  });

  // ── POST /admin/kyc/:id/document-url ──────────────────────────────────────

  describe('POST /api/hub/admin/kyc/:id/document-url', () => {
    it('hands back a 900-SECOND signed URL, never a seven-day one', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body.data).toMatchObject({ signed: true, expiresInSeconds: 900 });
      const url: string = res.body.data.url;
      // 900 seconds — StorageService.signedReadUrl. NOT readUrlFor's 604800.
      expect(url).toContain('X-Amz-Expires=900');
      expect(url).not.toContain('X-Amz-Expires=604800');
      expect(url).toContain('kyc/id-document');
      // Forced download, never rendered in place — StorageService's own rule.
      expect(decodeURIComponent(url)).toContain('attachment');
    });

    it('never persists, echoes or logs the signed URL', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .expect(200);
      const url: string = res.body.data.url;

      // The stored row still holds the bare object key it always held.
      const row = await prisma.kycSubmission.findUniqueOrThrow({ where: { id: SUB_PENDING_OLD } });
      expect(row.idDocumentUrl).toBe(DOC_STORED_KEY);

      // And the audit trail records THAT a fetch happened, never the means to
      // repeat it — a signed URL is a bearer token for a government ID.
      const audits = await prisma.adminKycAudit.findMany({ where: { submissionId: SUB_PENDING_OLD } });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain('X-Amz-Signature');
      expect(JSON.stringify(audits)).not.toContain(url.slice(0, 40));
    });

    it('writes an audit row naming the admin who opened the ID', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/document-url`)
        .set(auth(superToken))
        .expect(200);

      expect(res.body.data.audit).toMatchObject({
        action: 'document_viewed',
        previousStatus: null,
        newStatus: null,
        reason: null,
        actedByAdminId: ADMIN_SUPER_ID,
        actedByAdminEmail: SUPER_EMAIL,
        actedByAdminRole: 'superadmin',
      });

      const detail = await http()
        .get(`/api/hub/admin/kyc/${SUB_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(detail.body.data.auditTrail).toHaveLength(1);
      expect(detail.body.data.auditTrail[0].action).toBe('document_viewed');
    });

    it('says so honestly when a legacy row holds an absolute URL that cannot be signed', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_NEW}/document-url`)
        .set(auth(reviewerToken))
        .expect(200);

      // Reporting "900 seconds" over a permanent link would be a lie about how
      // long it lives.
      expect(res.body.data).toMatchObject({
        signed: false,
        expiresInSeconds: null,
        expiresAt: null,
        url: DOC_STORED_LEGACY_URL,
      });
    });

    it('404s an unknown id, and 404s a submission with no document', async () => {
      await http()
        .post(`/api/hub/admin/kyc/${UNKNOWN_SUB}/document-url`)
        .set(auth(reviewerToken))
        .expect(404);

      await prisma.kycSubmission.update({
        where: { id: SUB_PENDING_OLD },
        data: { idDocumentUrl: '' },
      });
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/document-url`)
        .set(auth(reviewerToken))
        .expect(404);
      expect(res.body.message).toBe('This submission has no ID document.');
    });
  });

  // ── POST /admin/kyc/:id/reveal ────────────────────────────────────────────

  describe('POST /api/hub/admin/kyc/:id/reveal', () => {
    it('returns the unmasked identifiers and audits the disclosure', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reveal`)
        .set(auth(reviewerToken))
        .expect(200);

      expect(res.body.data).toMatchObject({
        bvn: BVN,
        nin: NIN,
        nationalIdEquivalent: null,
        payoutBankName: 'GTBank',
        payoutAccountNumber: ACCOUNT_NUMBER,
      });
      expect(res.body.data.audit).toMatchObject({
        action: 'identifiers_revealed',
        actedByAdminId: ADMIN_REVIEWER_ID,
        actedByAdminEmail: REVIEWER_EMAIL,
        actedByAdminRole: 'reviewer',
      });

      const rows = await prisma.adminKycAudit.findMany({ where: { submissionId: SUB_PENDING_OLD } });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('identifiers_revealed');
      // The numbers themselves are not copied into the trail.
      expect(JSON.stringify(rows)).not.toContain(BVN);
    });

    it('leaves the queue and the detail masked — unmasking is a separate, recorded act', async () => {
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reveal`)
        .set(auth(reviewerToken))
        .expect(200);

      const detail = await http()
        .get(`/api/hub/admin/kyc/${SUB_PENDING_OLD}`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(detail.body.data.identifiers.bvnMasked).toBe(MASKED_BVN);
      expect(JSON.stringify(detail.body.data.identifiers)).not.toContain(BVN);
    });
  });

  // ── POST /admin/kyc/:id/approve ───────────────────────────────────────────

  describe('POST /api/hub/admin/kyc/:id/approve', () => {
    it('clears the creator to earn, as the EXISTING /creator/state endpoint reports it', async () => {
      // Before: the creator's own screen says the earning gate is still shut.
      // This is the state every creator on this platform has been stuck in.
      expect(await creatorStateKycStatus(resubmittingCreatorToken)).toBe('pending');

      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
      expect(res.body.data.submission.status).toBe('approved');

      // After: the same unmodified app endpoint, same creator token.
      expect(await creatorStateKycStatus(resubmittingCreatorToken)).toBe('approved');
    });

    it('touches the EARNING gate only — never the subscription, tier or slots', async () => {
      const before = await prisma.creatorState.findUniqueOrThrow({
        where: { wawuUserId: CREATOR_RESUBMITTING },
      });

      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);

      const after = await prisma.creatorState.findUniqueOrThrow({
        where: { wawuUserId: CREATOR_RESUBMITTING },
      });
      expect(after.kycStatus).toBe('approved');
      // "Paid + uploading + KYC pending" is a normal state in this product;
      // clearing one gate must not silently move the other.
      expect(after.subscriptionPaid).toBe(before.subscriptionPaid);
      expect(after.tier).toBe(before.tier);
      expect(after.slotsUsed).toBe(before.slotsUsed);
      expect(after.dmEnabled).toBe(before.dmEnabled);
    });

    it('writes an audit row naming who approved it, when, and from which status', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)
        .set(auth(superToken))
        .expect(200);

      expect(res.body.data.audit).toMatchObject({
        action: 'approved',
        previousStatus: 'pending',
        newStatus: 'approved',
        reason: null,
        actedByAdminId: ADMIN_SUPER_ID,
        actedByAdminEmail: SUPER_EMAIL,
        actedByAdminRole: 'superadmin',
      });

      const rows = await prisma.adminKycAudit.findMany({ where: { submissionId: SUB_PENDING_OLD } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subjectWawuUserId: CREATOR_RESUBMITTING,
        action: 'approved',
        actedByAdminEmail: SUPER_EMAIL,
      });
      expect(rows[0].actedAt).toBeInstanceOf(Date);

      expect(res.body.data.submission.auditTrail).toHaveLength(1);
    });

    it('400s a submission that is not pending, and writes no second audit row', async () => {
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_REJECTED}/approve`)
        .set(auth(reviewerToken))
        .expect(400);
      expect(res.body.message).toBe('Only a pending KYC submission can be reviewed');
      expect(await prisma.adminKycAudit.count({ where: { submissionId: SUB_REJECTED } })).toBe(0);
    });

    it('refuses a second decision on the same submission — one audit row, one gate change', async () => {
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)
        .set(auth(reviewerToken))
        .expect(400);
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'Changed my mind.' })
        .expect(400);

      expect(await prisma.adminKycAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(1);
      expect(await creatorStateKycStatus(resubmittingCreatorToken)).toBe('approved');
    });

    it('404s an unknown id', async () => {
      await http().post(`/api/hub/admin/kyc/${UNKNOWN_SUB}/approve`).set(auth(reviewerToken)).expect(404);
    });
  });

  // ── POST /admin/kyc/:id/reject ────────────────────────────────────────────

  describe('POST /api/hub/admin/kyc/:id/reject', () => {
    it('requires a reason', async () => {
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({})
        .expect(400);

      // A single space is not a reason.
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: '   ' })
        .expect(400);
      expect(res.body.message).toBe('reason is required — the creator is shown it.');

      // Nothing was written on either refusal, and the gate did not move.
      const row = await prisma.kycSubmission.findUniqueOrThrow({ where: { id: SUB_PENDING_OLD } });
      expect(row.status).toBe('pending');
      expect(await prisma.adminKycAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(0);
      expect(await creatorStateKycStatus(resubmittingCreatorToken)).toBe('pending');
    });

    it('400s a reason longer than 1000 characters', async () => {
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason: 'x'.repeat(1001) })
        .expect(400);
    });

    it('records the reason, moves the gate to rejected, and audits it', async () => {
      const reason = 'The account number does not match the name on the ID.';
      const res = await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reject`)
        .set(auth(reviewerToken))
        .send({ reason })
        .expect(200);

      expect(res.body.data.submission).toMatchObject({ status: 'rejected', rejectionReason: reason });
      expect(res.body.data.audit).toMatchObject({
        action: 'rejected',
        previousStatus: 'pending',
        newStatus: 'rejected',
        reason,
      });

      // The creator's own endpoint reflects it, so they can see they need to
      // act — and the existing POST /kyc lets them resubmit after a rejection.
      expect(await creatorStateKycStatus(resubmittingCreatorToken)).toBe('rejected');
    });
  });

  // ── auth + role matrix ────────────────────────────────────────────────────

  describe('who may reach this surface', () => {
    /**
     * Every route on this resource, as thunks. Built lazily on purpose:
     * supertest binds a fresh ephemeral listener per `request(...)` call, so
     * constructing six up front and awaiting them one at a time races their
     * own sockets.
     */
    const everyRoute = (token?: string): Array<() => request.Test> => {
      const withAuth = (r: request.Test) => (token ? r.set(auth(token)) : r);
      return [
        () => withAuth(http().get('/api/hub/admin/kyc/queue')),
        () => withAuth(http().get(`/api/hub/admin/kyc/${SUB_PENDING_OLD}`)),
        () => withAuth(http().post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/document-url`)),
        () => withAuth(http().post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reveal`)),
        () => withAuth(http().post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)),
        () => withAuth(http().post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/reject`).send({ reason: 'no' })),
      ];
    };

    it('refuses an unauthenticated request on every route', async () => {
      for (const call of everyRoute()) {
        await call().expect(401);
      }
    });

    it('refuses a valid WAWU ID USER token — an app user cannot review KYC', async () => {
      for (const call of everyRoute(userToken)) {
        await call().expect(401);
      }
      const row = await prisma.kycSubmission.findUniqueOrThrow({ where: { id: SUB_PENDING_OLD } });
      expect(row.status).toBe('pending');
    });

    /**
     * Support is refused the whole resource, not merely the writes — the
     * deliberate difference from ../../content-review, where support CAN read
     * the queue. These rows hold a BVN, a NIN and a payout account number for
     * a named creator; "what is happening with my KYC?" is answerable from
     * CreatorState.kycStatus, which carries no PII.
     */
    it('refuses SUPPORT on every route, reads included', async () => {
      for (const call of everyRoute(supportToken)) {
        await call().expect(403);
      }
      const res = await http().get('/api/hub/admin/kyc/queue').set(auth(supportToken)).expect(403);
      expect(res.body.message).toBe('This action is not available to your admin role.');
      expect(await prisma.adminKycAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(0);
    });

    it('refuses FINANCE on every route — payout details are not a finance view', async () => {
      for (const call of everyRoute(financeToken)) {
        await call().expect(403);
      }
      expect(await prisma.adminKycAudit.count({ where: { submissionId: SUB_PENDING_OLD } })).toBe(0);
    });

    it('lets superadmin and reviewer decide', async () => {
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_OLD}/approve`)
        .set(auth(superToken))
        .expect(200);
      await http()
        .post(`/api/hub/admin/kyc/${SUB_PENDING_NEW}/approve`)
        .set(auth(reviewerToken))
        .expect(200);
    });

    it('refuses a suspended admin mid-session', async () => {
      await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { status: 'suspended' } });
      try {
        await http().get('/api/hub/admin/kyc/queue').set(auth(reviewerToken)).expect(401);
      } finally {
        await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { status: 'active' } });
      }
    });
  });

  // ── the two gates stay apart ──────────────────────────────────────────────

  it('never mentions the verification-tier ladder anywhere in its responses', async () => {
    const queue = await http()
      .get('/api/hub/admin/kyc/queue')
      .query({ perPage: 100 })
      .set(auth(reviewerToken))
      .expect(200);
    const detail = await http()
      .get(`/api/hub/admin/kyc/${SUB_PENDING_OLD}`)
      .set(auth(reviewerToken))
      .expect(200);

    // KYC is the earning gate; the tier ladder is a public trust badge. They
    // are separate systems by product rule and the conflation has shipped once
    // already — no field of one may appear on the other.
    for (const body of [JSON.stringify(queue.body), JSON.stringify(detail.body)]) {
      expect(body).not.toContain('verificationTier');
      expect(body).not.toContain('verified_user');
      expect(body).not.toContain('trusted_partner');
      expect(body).not.toContain('badge');
    }
  });
});
