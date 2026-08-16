import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { VerificationSubmissionModule } from '../verification-submission.module';

/**
 * Contract tests for registry.json "VerificationSubmission". Auth is
 * exercised end-to-end against the shared local mock WAWU ID service (real
 * RS256 JWT, verified over real HTTP JWKS fetch) per conventions.md §
 * Local test environment — no minted/injected tokens for the two seeded
 * users; the "admin" identity is a third, freshly-minted real JWT (same
 * pattern credits-state's tests use for a non-seeded user) signed with the
 * mock service's own private key, since no admin concept exists in WAWU ID
 * or mock-wawu-id/server.js yet (see ../guards/admin.guard.ts).
 */

const MOCK_WAWU_ID_URL = 'http://localhost:4001';

// Seeded wawuUserIds (mirrors mock-wawu-id/server.js and prisma/seed.ts).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // verificationTier: verified_user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // verificationTier: basic
const ADMIN_WAWU_ID = '00000000-0000-4000-8000-0000000000ad'; // not a seeded WAWU-ID user; admin allowlist only

const TIER_ORDER = [
  'basic',
  'verified_user',
  'verified_business',
  'certified_professional',
  'trusted_partner',
];

async function loginFull(identifier: string): Promise<{ accessToken: string; verificationTier: string }> {
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

async function loginAs(identifier: string): Promise<string> {
  return (await loginFull(identifier)).accessToken;
}

/**
 * No admin identity exists anywhere in WAWU ID / mock-wawu-id yet (see
 * ../guards/admin.guard.ts's doc comment) — mints a real, JWKS-verifiable
 * JWT for a non-seeded sub, same technique credits-state's contract spec
 * uses to exercise its lazy-create path for a fresh user.
 */
async function mintTokenFor(sub: string, verificationTier = 'basic'): Promise<string> {
  const jwt = await import('jsonwebtoken');
  const fs = await import('fs');
  const path = await import('path');
  const privateKey = fs.readFileSync(path.join(__dirname, '../../../mock-wawu-id/private.pem'), 'utf8');
  return jwt.sign(
    {
      sub,
      email: `${sub}@test.wawu.dev`,
      phone: '+2348000009999',
      firstName: 'Admin',
      lastName: 'Reviewer',
      country: 'Nigeria',
      verificationTier,
      trustScore: 0,
      status: 'active',
      platformRefs: { wawuafricaAppUserId: sub },
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

describe('VerificationSubmission contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let creatorToken: string;
  let adminToken: string;
  // The mock WAWU ID service is a shared, long-lived process (conventions.md
  // § Local test environment) — its in-memory verificationTier for a seeded
  // user persists across test *runs*, not just within one. This suite's own
  // "approval elevates the tier" test genuinely mutates it via a real HTTP
  // call, so: (1) never hardcode the expected starting tier, capture it
  // live at the top of this run instead, and (2) restore it in afterAll so
  // reruns of this suite — and any other resource's suite that happens to
  // run after it against the same mock server — see a stable value.
  let userStartingVerificationTier: string;

  beforeAll(async () => {
    // AdminGuard reads this at request time via ConfigService — must be set
    // before ConfigModule.forRoot() compiles below.
    process.env.ADMIN_WAWU_USER_IDS = ADMIN_WAWU_ID;

    const userLogin = await loginFull('user@test.wawu.dev');
    userToken = userLogin.accessToken;
    userStartingVerificationTier = userLogin.verificationTier;
    creatorToken = await loginAs('creator-basic@test.wawu.dev');
    adminToken = await mintTokenFor(ADMIN_WAWU_ID);

    // VerificationSubmissionModule already imports WawuAuthModule (for
    // WawuIdClient), which registers the 'wawu-jwt' passport strategy — no
    // need to duplicate PassportModule.register/WawuJwtStrategy here.
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, VerificationSubmissionModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // Clean slate for the two seeded identities this spec drives through
    // the full submit -> reject -> resubmit -> approve lifecycle.
    await prisma.verificationSubmission.deleteMany({
      where: { wawuUserId: { in: [USER_PLAIN, USER_CREATOR_BASIC] } },
    });
  });

  afterAll(async () => {
    await prisma.verificationSubmission.deleteMany({
      where: { wawuUserId: { in: [USER_PLAIN, USER_CREATOR_BASIC] } },
    });
    // Restore the mock WAWU ID service's tier for this seeded user (see the
    // comment on userStartingVerificationTier above).
    await fetch(`${MOCK_WAWU_ID_URL}/internal/users/${USER_PLAIN}/verification-tier`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': process.env.WAWU_ID_INTERNAL_SERVICE_KEY ?? 'dev-internal-service-key-not-secret',
      },
      body: JSON.stringify({ tier: userStartingVerificationTier }),
    });
    await app.close();
  });

  describe('GET /api/hub/verification/ladder', () => {
    it('valid request -> 200 with all five tiers, correctly derived from the JWT claim', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/verification/ladder')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.data.map((e: { tier: string }) => e.tier)).toEqual([
        'basic',
        'verified_user',
        'verified_business',
        'certified_professional',
        'trusted_partner',
      ]);
      // Derived from the JWT's live verificationTier claim, not hardcoded
      // (see userStartingVerificationTier's comment above).
      const currentRank = TIER_ORDER.indexOf(userStartingVerificationTier);
      for (const entry of res.body.data as { tier: string; achieved: boolean; currentTier: boolean; submission: unknown }[]) {
        const rank = TIER_ORDER.indexOf(entry.tier);
        expect(entry.achieved).toBe(rank <= currentRank);
        expect(entry.currentTier).toBe(rank === currentRank);
        // No submissions exist yet at this point in the suite (cleaned in beforeAll).
        expect(entry.submission).toBeNull();
      }
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/hub/verification/ladder').expect(401);
    });
  });

  let submissionId: string;

  describe('POST /api/hub/verification/submissions', () => {
    it('400s on an invalid tier value', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'gold', documents: ['https://storage.test/doc1.pdf'] })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'verified_business', documents: ['https://storage.test/doc1.pdf'], status: 'approved' })
        .expect(400);
    });

    it('400s on an empty documents array', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'verified_business', documents: [] })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/verification/submissions')
        .send({ tier: 'verified_business', documents: ['https://storage.test/doc1.pdf'] })
        .expect(401);
    });

    it('creates a pending submission for a valid request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'verified_business', documents: ['https://storage.test/doc1.pdf'] });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toMatchObject({
        wawuUserId: USER_PLAIN,
        tier: 'verified_business',
        status: 'pending',
        documents: ['https://storage.test/doc1.pdf'],
        reviewedAt: null,
        rejectionReason: null,
      });
      expect(res.body.data.id).toEqual(expect.any(String));
      submissionId = res.body.data.id;

      const stored = await prisma.verificationSubmission.findUnique({ where: { id: submissionId } });
      expect(stored).not.toBeNull();
    });

    it('400s a second submission while one is already pending', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'certified_professional', documents: ['https://storage.test/doc2.pdf'] })
        .expect(400);

      expect(res.body.data).toBeNull();
    });
  });

  describe('GET /api/hub/verification/submissions', () => {
    it("returns only the caller's own submissions", async () => {
      const mine = await request(app.getHttpServer())
        .get('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(mine.body.data.map((s: { id: string }) => s.id)).toContain(submissionId);

      const others = await request(app.getHttpServer())
        .get('/api/hub/verification/submissions')
        .set('Authorization', `Bearer ${creatorToken}`)
        .expect(200);
      expect(others.body.data.map((s: { id: string }) => s.id)).not.toContain(submissionId);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/hub/verification/submissions').expect(401);
    });
  });

  describe('POST /api/hub/verification/submissions/:id/review (roles: admin)', () => {
    it('403s for an authenticated non-admin user', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ decision: 'approved' })
        .expect(403);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .send({ decision: 'approved' })
        .expect(401);
    });

    it('400s on an invalid decision value', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'maybe' })
        .expect(400);
    });

    it('400s a rejection with no rejectionReason', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'rejected' })
        .expect(400);
    });

    it('404s for a nonexistent submission id', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/verification/submissions/ffffffff-0000-4000-8000-000000000099/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' })
        .expect(404);
    });

    it('rejects the submission for a valid admin request (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'rejected', rejectionReason: 'Documents were blurry' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: submissionId,
        status: 'rejected',
        rejectionReason: 'Documents were blurry',
      });
      expect(res.body.data.reviewedAt).toEqual(expect.any(String));
    });

    it('400s reviewing a submission that is no longer pending', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' })
        .expect(400);
    });
  });

  describe('POST /api/hub/verification/submissions/:id/resubmit', () => {
    it('403s for a user who does not own the submission', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/resubmit`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ documents: ['https://storage.test/doc3.pdf'] })
        .expect(403);

      expect(res.body.data).toBeNull();
    });

    it('400s on an invalid payload (empty documents)', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/resubmit`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ documents: [] })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/resubmit`)
        .send({ documents: ['https://storage.test/doc3.pdf'] })
        .expect(401);
    });

    it('resubmits a rejected submission back to pending for a valid request (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/resubmit`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ documents: ['https://storage.test/doc3-resubmitted.pdf'] })
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: submissionId,
        status: 'pending',
        documents: ['https://storage.test/doc3-resubmitted.pdf'],
        reviewedAt: null,
        rejectionReason: null,
      });
    });

    it('400s resubmitting a submission that is not rejected', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/resubmit`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ documents: ['https://storage.test/doc4.pdf'] })
        .expect(400);
    });
  });

  describe('approval calls back to WAWU ID (elevateVerificationTier)', () => {
    it('elevates the WAWU ID verificationTier claim on approval', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' })
        .expect(200);

      expect(res.body.data).toMatchObject({ id: submissionId, status: 'approved' });

      // Confirm the tier change actually landed at WAWU ID (real HTTP call,
      // not a locally-cached flag) by logging in again and reading the
      // fresh claim off the newly-issued token.
      const freshLogin = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
      });
      const body = (await freshLogin.json()) as { user: { verificationTier: string } };
      expect(body.user.verificationTier).toBe('verified_business');
    });
  });
});
