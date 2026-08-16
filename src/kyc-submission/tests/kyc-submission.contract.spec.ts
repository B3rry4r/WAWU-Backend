import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { KycSubmissionModule } from '../kyc-submission.module';

/**
 * Contract tests for registry.json "KycSubmission". Auth is exercised
 * end-to-end against the shared local mock WAWU ID service (real RS256 JWT,
 * verified over real HTTP JWKS fetch) per conventions.md § Local test
 * environment — no minted/injected tokens for the three seeded users; the
 * "admin" identity is a freshly-minted real JWT (same pattern
 * verification-submission's spec uses), since no admin concept exists in
 * WAWU ID or mock-wawu-id/server.js yet (see ../guards/admin.guard.ts).
 */

const MOCK_WAWU_ID_URL = 'http://localhost:4001';

// Seeded wawuUserIds (mirrors mock-wawu-id/server.js and prisma/seed.ts).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user — no CreatorState row at all
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic tier, KYC pending
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro tier, KYC approved
const ADMIN_WAWU_ID = '00000000-0000-4000-8000-0000000000ad'; // not a seeded WAWU-ID user; admin allowlist only

// Seeded KycSubmission rows (prisma/seed.ts).
const KYC_BASIC_ID = '13000000-0000-4000-8000-000000000002';
const KYC_PRO_ID = '13000000-0000-4000-8000-000000000003';

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

/**
 * No admin identity exists anywhere in WAWU ID / mock-wawu-id yet (see
 * ../guards/admin.guard.ts's doc comment) — mints a real, JWKS-verifiable
 * JWT for a non-seeded sub, same technique verification-submission's
 * contract spec uses for its own admin token.
 */
async function mintTokenFor(sub: string): Promise<string> {
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
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
      platformRefs: { wawuafricaAppUserId: sub },
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

describe('KycSubmission contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let creatorBasicToken: string;
  let creatorProToken: string;
  let adminToken: string;

  const validNigeriaPayload = {
    country: 'Nigeria',
    bvn: '22212345678',
    nin: '11198765432',
    idDocumentType: 'passport',
    idDocumentUrl: 'https://storage.test/kyc/doc.pdf',
    payoutBankName: 'GTBank',
    payoutAccountNumber: '0123456789',
  };

  async function resetSeedState(): Promise<void> {
    // Remove any extra rows a previous (possibly interrupted) run of this
    // suite may have left behind for the basic creator, then restore both
    // seeded KycSubmission rows and both CreatorState.kycStatus values to
    // prisma/seed.ts's original values — makes this suite idempotent
    // across reruns without depending on a fresh `prisma db seed`.
    await prisma.kycSubmission.deleteMany({
      where: { wawuUserId: USER_CREATOR_BASIC, id: { not: KYC_BASIC_ID } },
    });
    await prisma.kycSubmission.upsert({
      where: { id: KYC_BASIC_ID },
      update: {
        status: 'pending',
        rejectionReason: null,
        reviewedAt: null,
        submittedAt: new Date(),
      },
      create: {
        id: KYC_BASIC_ID,
        wawuUserId: USER_CREATOR_BASIC,
        country: 'Nigeria',
        bvn: '22212345678',
        nin: '11198765432',
        nationalIdEquivalent: null,
        idDocumentType: 'nin_slip',
        idDocumentUrl: 'https://storage.seed.local/kyc/chidi-nin-slip.pdf',
        payoutBankName: 'GTBank',
        payoutAccountNumber: '0123456789',
        status: 'pending',
        rejectionReason: null,
        reviewedAt: null,
      },
    });
    await prisma.kycSubmission.upsert({
      where: { id: KYC_PRO_ID },
      update: { status: 'approved', rejectionReason: null },
      create: {
        id: KYC_PRO_ID,
        wawuUserId: USER_CREATOR_PRO,
        country: 'Nigeria',
        bvn: '22287654321',
        nin: '11112345678',
        nationalIdEquivalent: null,
        idDocumentType: 'nin_slip',
        idDocumentUrl: 'https://storage.seed.local/kyc/zainab-nin-slip.pdf',
        payoutBankName: 'Access Bank',
        payoutAccountNumber: '0098765432',
        status: 'approved',
        rejectionReason: null,
        reviewedAt: new Date(),
      },
    });
    await prisma.creatorState.update({ where: { wawuUserId: USER_CREATOR_BASIC }, data: { kycStatus: 'pending' } });
    await prisma.creatorState.update({ where: { wawuUserId: USER_CREATOR_PRO }, data: { kycStatus: 'approved' } });
  }

  beforeAll(async () => {
    // KycAdminGuard reads this at request time via ConfigService — must be
    // set before ConfigModule.forRoot() compiles below.
    process.env.ADMIN_WAWU_USER_IDS = ADMIN_WAWU_ID;

    userToken = await loginAs('user@test.wawu.dev');
    creatorBasicToken = await loginAs('creator-basic@test.wawu.dev');
    creatorProToken = await loginAs('creator-pro@test.wawu.dev');
    adminToken = await mintTokenFor(ADMIN_WAWU_ID);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, KycSubmissionModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    await resetSeedState();
  });

  afterAll(async () => {
    await resetSeedState();
    await app.close();
  });

  describe('GET /api/hub/kyc', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/hub/kyc').expect(401);
    });

    it('403s for a plain user with no CreatorState row', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/kyc')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it("returns the Pro creator's approved submission", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);
      expect(res.body.data).toMatchObject({
        id: KYC_PRO_ID,
        wawuUserId: USER_CREATOR_PRO,
        status: 'approved',
      });
    });

    it("returns the Basic creator's pending submission", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(200);
      expect(res.body.data).toMatchObject({
        id: KYC_BASIC_ID,
        wawuUserId: USER_CREATOR_BASIC,
        status: 'pending',
      });
    });
  });

  describe('POST /api/hub/kyc', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).post('/api/hub/kyc').send(validNigeriaPayload).expect(401);
    });

    it('403s for a plain user with no CreatorState row', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${userToken}`)
        .send(validNigeriaPayload)
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it('400s a Nigeria submission missing bvn/nin', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ ...validNigeriaPayload, bvn: undefined, nin: undefined })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('400s an invalid idDocumentType', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ ...validNigeriaPayload, idDocumentType: 'birth_certificate' })
        .expect(400);
    });

    it('400s a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ ...validNigeriaPayload, status: 'approved' })
        .expect(400);
    });

    it('400s while the caller already has a pending submission', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send(validNigeriaPayload)
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('400s while the caller is already approved', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send(validNigeriaPayload)
        .expect(400);
      expect(res.body.data).toBeNull();
    });
  });

  describe('full lifecycle: reject -> resubmit -> approve (drives the Basic creator through both terminal review outcomes)', () => {
    it('403s a review by an authenticated non-admin user', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/kyc/${KYC_BASIC_ID}/review`)
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ decision: 'approved' })
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/kyc/${KYC_BASIC_ID}/review`)
        .send({ decision: 'approved' })
        .expect(401);
    });

    it('400s an invalid decision value', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/kyc/${KYC_BASIC_ID}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'maybe' })
        .expect(400);
    });

    it('400s a rejection with no rejectionReason', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/kyc/${KYC_BASIC_ID}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'rejected' })
        .expect(400);
    });

    it('404s for a nonexistent submission id', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/kyc/ffffffff-0000-4000-8000-000000000099/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' })
        .expect(404);
    });

    it('rejects the pending submission for a valid admin request, and flips CreatorState.kycStatus to rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/kyc/${KYC_BASIC_ID}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'rejected', rejectionReason: 'BVN does not match the account holder name' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: KYC_BASIC_ID,
        status: 'rejected',
        rejectionReason: 'BVN does not match the account holder name',
      });
      expect(res.body.data.reviewedAt).toEqual(expect.any(String));

      const state = await prisma.creatorState.findUnique({ where: { wawuUserId: USER_CREATOR_BASIC } });
      expect(state?.kycStatus).toBe('rejected');
    });

    it('400s reviewing a submission that is no longer pending', async () => {
      await request(app.getHttpServer())
        .post(`/api/hub/kyc/${KYC_BASIC_ID}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' })
        .expect(400);
    });

    let resubmittedId: string;

    it('accepts a fresh POST /kyc submission after rejection, and flips CreatorState.kycStatus back to pending', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send(validNigeriaPayload);

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toMatchObject({
        wawuUserId: USER_CREATOR_BASIC,
        status: 'pending',
        country: 'Nigeria',
        bvn: '22212345678',
        nin: '11198765432',
      });
      expect(res.body.data.id).toEqual(expect.any(String));
      expect(res.body.data.id).not.toBe(KYC_BASIC_ID);
      resubmittedId = res.body.data.id;

      const state = await prisma.creatorState.findUnique({ where: { wawuUserId: USER_CREATOR_BASIC } });
      expect(state?.kycStatus).toBe('pending');
    });

    it('approves the resubmitted submission, and flips CreatorState.kycStatus to approved', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/kyc/${resubmittedId}/review`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' })
        .expect(200);

      expect(res.body.data).toMatchObject({ id: resubmittedId, status: 'approved', rejectionReason: null });

      const state = await prisma.creatorState.findUnique({ where: { wawuUserId: USER_CREATOR_BASIC } });
      expect(state?.kycStatus).toBe('approved');

      const latest = await request(app.getHttpServer())
        .get('/api/hub/kyc')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(200);
      expect(latest.body.data).toMatchObject({ id: resubmittedId, status: 'approved' });
    });
  });
});
