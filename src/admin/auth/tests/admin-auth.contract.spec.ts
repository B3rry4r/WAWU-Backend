import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { KycSubmissionModule } from '../../../kyc-submission/kyc-submission.module';
import { AdminAuthModule } from '../admin-auth.module';
import { ADMIN_ACCESS_AUDIENCE, ADMIN_TOKEN_ISSUER } from '../admin-token.service';

/**
 * Contract tests for the admin auth surface (admin-surface-extension Phase 5).
 *
 * Two things are being proved here, and the second matters more than the
 * first:
 *
 * 1. The endpoints behave — login/refresh/me/admins, the role matrix, the
 *    revocation path, and the error envelope.
 * 2. CROSS-REJECTION IN BOTH DIRECTIONS. An admin token must fail user auth,
 *    and a WAWU ID token must fail admin auth — including a WAWU ID REFRESH
 *    token, which .pipeline/protected-registry.json records as currently
 *    satisfying every user guard on this backend (passport-jwt checks only
 *    signature and expiry, and neither `iss` nor `aud` is enforced). That
 *    defect is a protected surface: this suite ASSERTS it still behaves that
 *    way on the user side rather than repairing it, and proves the admin side
 *    is immune to it by construction.
 *
 * The separation being tested is cryptographic, not claim-based: admin tokens
 * are HS256 against a local secret, user tokens are RS256 against WAWU ID's
 * JWKS. The forgery tests below (RS256-signed admin-shaped token, alg:none,
 * wrong HS256 secret) are the ones that pin that down.
 *
 * Fixtures: five AdminUser rows under this suite's own id prefix, deleted in
 * afterAll (README § Test hygiene rules, rule 1). No seeded row is touched;
 * the KycSubmission module is mounted read-only, purely to have a real
 * user-guarded route to fire admin tokens at.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded WAWU ID user (mock-wawu-id/server.js + prisma/seed.ts). */
const USER_PLAIN = 'user@test.wawu.dev';

/** A real user-guarded route from the protected surface, used as the cross-rejection target. */
const USER_GUARDED_ROUTE = '/api/hub/kyc';

// Suite-owned fixtures. `ad……` prefix belongs to this spec and nothing else.
const ADMIN_SUPER_ID = 'ad000000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'ad000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'ad000000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'ad000000-0000-4000-8000-000000000004';
const ADMIN_SUSPENDED_ID = 'ad000000-0000-4000-8000-000000000005';
const FIXTURE_IDS = [ADMIN_SUPER_ID, ADMIN_REVIEWER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID, ADMIN_SUSPENDED_ID];

const SUPER_EMAIL = 'contract-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'contract-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'contract-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'contract-finance@admin.test.wawu.dev';
const SUSPENDED_EMAIL = 'contract-suspended@admin.test.wawu.dev';

const PASSWORD = 'contract-test-admin-password';

const TEST_ACCESS_SECRET = 'admin-contract-test-access-secret-0123456789';
const TEST_REFRESH_SECRET = 'admin-contract-test-refresh-secret-0123456789';

async function loginToWawuId(identifier: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

describe('Admin auth contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superTokens: { accessToken: string; refreshToken: string };

  let wawuUserAccessToken: string;
  let wawuUserRefreshToken: string;

  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());

  // Not async on purpose: callers chain supertest's own .expect() off it.
  function login(email: string, password = PASSWORD) {
    return http().post('/api/hub/admin/auth/login').send({ email, password });
  }

  async function loginOk(email: string): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await login(email).expect(200);
    return { accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken };
  }

  async function seedFixtures(): Promise<void> {
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: FIXTURE_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, name: 'Contract Super', role: 'superadmin', passwordHash },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, name: 'Contract Reviewer', role: 'reviewer', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'Contract Support', role: 'support', passwordHash },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'Contract Finance', role: 'finance', passwordHash },
        {
          id: ADMIN_SUSPENDED_ID,
          email: SUSPENDED_EMAIL,
          name: 'Contract Suspended',
          role: 'support',
          status: 'suspended',
          passwordHash,
        },
      ],
    });
  }

  beforeAll(async () => {
    // The admin token secrets are read live off process.env through
    // ConfigService, and are deliberately absent from .env/.env.example — an
    // unconfigured admin surface is an unreachable one. Pinned here and put
    // back in afterAll, since --runInBand shares one process.env.
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET', 'ADMIN_JWT_ACCESS_TTL']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    const wawuTokens = await loginToWawuId(USER_PLAIN);
    wawuUserAccessToken = wawuTokens.accessToken;
    wawuUserRefreshToken = wawuTokens.refreshToken;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        // Only here so the cross-rejection tests fire at a REAL user-guarded
        // route rather than a stub. Nothing in it is modified or written to.
        WawuAuthModule,
        KycSubmissionModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    await seedFixtures();

    superTokens = await loginOk(SUPER_EMAIL);
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: { in: FIXTURE_IDS } } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('POST /api/hub/admin/auth/login', () => {
    it('returns a token pair and the admin view in the standard envelope', async () => {
      const res = await login(SUPER_EMAIL).expect(200);
      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
      expect(res.body.data.expiresIn).toBe(30 * 60);
      expect(res.body.data.admin).toMatchObject({
        id: ADMIN_SUPER_ID,
        email: SUPER_EMAIL,
        name: 'Contract Super',
        role: 'superadmin',
        status: 'active',
      });
    });

    it('never puts passwordHash or tokenVersion on the wire', async () => {
      const res = await login(SUPER_EMAIL).expect(200);
      expect(res.body.data.admin).not.toHaveProperty('passwordHash');
      expect(res.body.data.admin).not.toHaveProperty('tokenVersion');
      expect(JSON.stringify(res.body)).not.toContain('$argon2');
    });

    it('issues an access and a refresh token that are not the same token', async () => {
      const res = await login(SUPER_EMAIL).expect(200);
      expect(res.body.data.accessToken).not.toEqual(res.body.data.refreshToken);
    });

    it('matches the email case-insensitively', async () => {
      await login(SUPER_EMAIL.toUpperCase()).expect(200);
    });

    it('records lastLoginAt', async () => {
      await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { lastLoginAt: null } });
      await login(REVIEWER_EMAIL).expect(200);
      const row = await prisma.adminUser.findUnique({ where: { id: ADMIN_REVIEWER_ID } });
      expect(row?.lastLoginAt).toBeInstanceOf(Date);
    });

    it('401s on a wrong password, without saying which half was wrong', async () => {
      const res = await login(SUPER_EMAIL, 'not-the-password').expect(401);
      expect(res.body).toEqual({ statusCode: 401, message: 'Invalid email or password.', data: null });
    });

    it('401s on an unknown email with the identical message', async () => {
      const res = await login('nobody@admin.test.wawu.dev').expect(401);
      expect(res.body).toEqual({ statusCode: 401, message: 'Invalid email or password.', data: null });
    });

    it('403s a suspended admin who supplies the correct password', async () => {
      const res = await login(SUSPENDED_EMAIL).expect(403);
      expect(res.body.message).toBe('This admin account is suspended.');
    });

    it('400s on a malformed email, a missing password, and an unknown property', async () => {
      await login('not-an-email').expect(400);
      await http().post('/api/hub/admin/auth/login').send({ email: SUPER_EMAIL }).expect(400);
      await http()
        .post('/api/hub/admin/auth/login')
        .send({ email: SUPER_EMAIL, password: PASSWORD, role: 'superadmin' })
        .expect(400);
    });

    it('fails CLOSED when ADMIN_JWT_SECRET is unset', async () => {
      delete process.env.ADMIN_JWT_SECRET;
      try {
        const res = await login(SUPER_EMAIL).expect(401);
        expect(res.body.message).toBe('Admin access is not configured on this server.');
      } finally {
        process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
      }
    });
  });

  describe('GET /api/hub/admin/auth/me', () => {
    it('returns the signed-in admin', async () => {
      const res = await http()
        .get('/api/hub/admin/auth/me')
        .set('Authorization', `Bearer ${superTokens.accessToken}`)
        .expect(200);
      expect(res.body.data).toMatchObject({ id: ADMIN_SUPER_ID, email: SUPER_EMAIL, role: 'superadmin' });
      expect(res.body.data).not.toHaveProperty('passwordHash');
    });

    it('401s with no Authorization header', async () => {
      const res = await http().get('/api/hub/admin/auth/me').expect(401);
      expect(res.body.message).toBe('Admin session required.');
    });

    it('401s when the scheme is not Bearer', async () => {
      await http()
        .get('/api/hub/admin/auth/me')
        .set('Authorization', `Token ${superTokens.accessToken}`)
        .expect(401);
    });

    it('401s on a garbage token', async () => {
      await http().get('/api/hub/admin/auth/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });

    it('401s on an HS256 token signed with a different secret', async () => {
      const jwt = await import('jsonwebtoken');
      const forged = jwt.sign(
        { email: SUPER_EMAIL, role: 'superadmin', tokenVersion: 0, typ: 'admin_access' },
        'a-different-secret-of-adequate-length-32',
        {
          algorithm: 'HS256',
          subject: ADMIN_SUPER_ID,
          issuer: ADMIN_TOKEN_ISSUER,
          audience: ADMIN_ACCESS_AUDIENCE,
          expiresIn: '15m',
        },
      );
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('401s on an alg:none token carrying perfect admin claims', async () => {
      const jwt = await import('jsonwebtoken');
      const forged = jwt.sign(
        { email: SUPER_EMAIL, role: 'superadmin', tokenVersion: 0, typ: 'admin_access' },
        '',
        {
          algorithm: 'none',
          subject: ADMIN_SUPER_ID,
          issuer: ADMIN_TOKEN_ISSUER,
          audience: ADMIN_ACCESS_AUDIENCE,
          expiresIn: '15m',
        },
      );
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('401s when a refresh token is presented as an access token', async () => {
      await http()
        .get('/api/hub/admin/auth/me')
        .set('Authorization', `Bearer ${superTokens.refreshToken}`)
        .expect(401);
    });

    it('401s once tokenVersion is bumped — revocation without a session table', async () => {
      const { accessToken } = await loginOk(SUPPORT_EMAIL);
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
      await prisma.adminUser.update({ where: { id: ADMIN_SUPPORT_ID }, data: { tokenVersion: { increment: 1 } } });
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    });

    it('401s once the admin is suspended, on a token issued while they were active', async () => {
      const { accessToken } = await loginOk(FINANCE_EMAIL);
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
      await prisma.adminUser.update({ where: { id: ADMIN_FINANCE_ID }, data: { status: 'suspended' } });
      try {
        await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      } finally {
        await prisma.adminUser.update({ where: { id: ADMIN_FINANCE_ID }, data: { status: 'active' } });
      }
    });

    it('401s when the admin row no longer exists', async () => {
      const jwt = await import('jsonwebtoken');
      const orphan = jwt.sign(
        { email: 'deleted@admin.test.wawu.dev', role: 'superadmin', tokenVersion: 0, typ: 'admin_access' },
        TEST_ACCESS_SECRET,
        {
          algorithm: 'HS256',
          subject: 'ad000000-0000-4000-8000-0000000000ff',
          issuer: ADMIN_TOKEN_ISSUER,
          audience: ADMIN_ACCESS_AUDIENCE,
          expiresIn: '15m',
        },
      );
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${orphan}`).expect(401);
    });
  });

  describe('POST /api/hub/admin/auth/refresh', () => {
    it('rotates a refresh token into a working new pair', async () => {
      const { refreshToken } = await loginOk(SUPER_EMAIL);
      const res = await http().post('/api/hub/admin/auth/refresh').send({ refreshToken }).expect(200);
      expect(res.body.data.admin).toMatchObject({ id: ADMIN_SUPER_ID });
      await http()
        .get('/api/hub/admin/auth/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
    });

    it('401s when handed an ACCESS token — the two secrets are not interchangeable', async () => {
      await http()
        .post('/api/hub/admin/auth/refresh')
        .send({ refreshToken: superTokens.accessToken })
        .expect(401);
    });

    it('401s after tokenVersion is bumped', async () => {
      const { refreshToken } = await loginOk(REVIEWER_EMAIL);
      await prisma.adminUser.update({ where: { id: ADMIN_REVIEWER_ID }, data: { tokenVersion: { increment: 1 } } });
      await http().post('/api/hub/admin/auth/refresh').send({ refreshToken }).expect(401);
    });

    it('401s on a garbage refresh token and 400s on a missing one', async () => {
      await http().post('/api/hub/admin/auth/refresh').send({ refreshToken: 'not.a.jwt' }).expect(401);
      await http().post('/api/hub/admin/auth/refresh').send({}).expect(400);
    });
  });

  describe('Role matrix — GET /api/hub/admin/auth/admins (superadmin only)', () => {
    it('lets a superadmin read the roster, without password hashes', async () => {
      const res = await http()
        .get('/api/hub/admin/auth/admins')
        .set('Authorization', `Bearer ${superTokens.accessToken}`)
        .expect(200);
      const emails = (res.body.data as { email: string }[]).map((a) => a.email);
      expect(emails).toEqual(expect.arrayContaining([SUPER_EMAIL, REVIEWER_EMAIL, FINANCE_EMAIL]));
      expect(JSON.stringify(res.body)).not.toContain('$argon2');
    });

    // Logged in per case rather than reusing a token from beforeAll: the
    // revocation tests above deliberately bump tokenVersion on two of these
    // admins, and a stale token would fail this as a 401 and look like a role
    // bug.
    it.each([
      ['reviewer', REVIEWER_EMAIL],
      ['support', SUPPORT_EMAIL],
      ['finance', FINANCE_EMAIL],
    ])('403s an authenticated %s', async (_role, email) => {
      const { accessToken } = await loginOk(email);
      const res = await http()
        .get('/api/hub/admin/auth/admins')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
      expect(res.body.message).toBe('This action is not available to your admin role.');
    });

    it('401s (not 403s) with no token at all — auth runs before the role check', async () => {
      await http().get('/api/hub/admin/auth/admins').expect(401);
    });
  });

  describe('Cross-rejection: an admin token must fail USER auth', () => {
    it('control — a real WAWU ID token is ACCEPTED by the user guard on the same route', async () => {
      // 403, not 401: the plain seeded user authenticates fine and is then
      // turned away for not being a creator. That distinction is the whole
      // point of using this route as the probe.
      await http().get(USER_GUARDED_ROUTE).set('Authorization', `Bearer ${wawuUserAccessToken}`).expect(403);
    });

    it('401s an admin ACCESS token at a user-guarded route', async () => {
      await http().get(USER_GUARDED_ROUTE).set('Authorization', `Bearer ${superTokens.accessToken}`).expect(401);
    });

    it('401s an admin REFRESH token at a user-guarded route', async () => {
      await http().get(USER_GUARDED_ROUTE).set('Authorization', `Bearer ${superTokens.refreshToken}`).expect(401);
    });
  });

  describe('Cross-rejection: a WAWU ID token must fail ADMIN auth', () => {
    it('401s a WAWU ID access token at /admin/auth/me', async () => {
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${wawuUserAccessToken}`).expect(401);
    });

    it('401s a WAWU ID REFRESH token at /admin/auth/me', async () => {
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${wawuUserRefreshToken}`).expect(401);
    });

    it('401s a WAWU ID refresh token at /admin/auth/refresh', async () => {
      await http()
        .post('/api/hub/admin/auth/refresh')
        .send({ refreshToken: wawuUserRefreshToken })
        .expect(401);
    });

    it('documents the protected-surface defect it relies on: that same WAWU ID REFRESH token still satisfies USER auth', async () => {
      // protected-registry.json § auth.sso.securityConsequence — the Hub
      // checks only signature and expiry on user tokens, so a refresh token
      // passes every user guard. NOT repaired here (protected surface); this
      // assertion exists so that if someone ever does fix it, they are told
      // that the admin-side reasoning depended on it being true.
      await http().get(USER_GUARDED_ROUTE).set('Authorization', `Bearer ${wawuUserRefreshToken}`).expect(403);
    });

    it('401s an RS256 token minted by WAWU ID’s own key carrying perfect admin claims', async () => {
      const jwt = await import('jsonwebtoken');
      const fs = await import('fs');
      const path = await import('path');
      const privateKey = fs.readFileSync(path.join(__dirname, '../../../../mock-wawu-id/private.pem'), 'utf8');
      const forged = jwt.sign(
        { email: SUPER_EMAIL, role: 'superadmin', tokenVersion: 0, typ: 'admin_access' },
        privateKey,
        {
          algorithm: 'RS256',
          keyid: 'mock-wawu-id-key-1',
          subject: ADMIN_SUPER_ID,
          issuer: ADMIN_TOKEN_ISSUER,
          audience: ADMIN_ACCESS_AUDIENCE,
          expiresIn: '15m',
        },
      );
      await http().get('/api/hub/admin/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });
  });
});
