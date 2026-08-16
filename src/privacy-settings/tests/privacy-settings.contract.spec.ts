import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrivacySettingsModule } from '../privacy-settings.module';

/**
 * Contract tests for registry.json "PrivacySettings" (GET/PATCH
 * /settings/privacy, roles: ["any"]). Auth is exercised end-to-end against
 * the shared local mock WAWU ID service (real RS256 JWT, verified over real
 * HTTP JWKS fetch) per conventions.md § Local test environment — no
 * minted/injected tokens for the seeded-user paths.
 */

const MOCK_WAWU_ID_URL = 'http://localhost:4001';

// Seeded wawuUserIds (task brief / mock-wawu-id/server.js).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';

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

describe('PrivacySettings contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plainUserToken: string;
  let creatorBasicToken: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        PrivacySettingsModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
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
    plainUserToken = await loginAs('user@test.wawu.dev');
    creatorBasicToken = await loginAs('creator-basic@test.wawu.dev');
  });

  afterAll(async () => {
    // Restore the seeded defaults so this test file is re-runnable and
    // doesn't leak mutated state into other suites sharing the test DB.
    await prisma.privacySettings.upsert({
      where: { userWawuId: USER_PLAIN },
      update: {
        showPurchases: true,
        showSavedItems: true,
        showFollowing: true,
        showInMemberLists: true,
      },
      create: { userWawuId: USER_PLAIN },
    });
    await app.close();
  });

  describe('GET /api/hub/settings/privacy', () => {
    it('valid request -> 200 with the seeded PrivacySettings shape (all true by default)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/settings/privacy')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          userWawuId: USER_PLAIN,
          showPurchases: true,
          showSavedItems: true,
          showFollowing: true,
          showInMemberLists: true,
        },
      });
    });

    it('lazily creates a PrivacySettings row (all defaults true) on first read for a user with none yet', async () => {
      const freshWawuId = '00000000-0000-4000-8000-00000000f00d';
      await prisma.privacySettings.deleteMany({ where: { userWawuId: freshWawuId } });

      const freshToken = await mintTokenFor(freshWawuId);

      const res = await request(app.getHttpServer())
        .get('/api/hub/settings/privacy')
        .set('Authorization', `Bearer ${freshToken}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: freshWawuId,
        showPurchases: true,
        showSavedItems: true,
        showFollowing: true,
        showInMemberLists: true,
      });

      const persisted = await prisma.privacySettings.findUnique({ where: { userWawuId: freshWawuId } });
      expect(persisted).not.toBeNull();

      await prisma.privacySettings.deleteMany({ where: { userWawuId: freshWawuId } });
    });

    it('missing auth -> 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/settings/privacy').expect(401);
      expect(res.body.statusCode).toBe(401);
      expect(res.body.data).toBeNull();
    });

    it('malformed bearer token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/settings/privacy')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
      expect(res.body.statusCode).toBe(401);
      expect(res.body.data).toBeNull();
    });
  });

  describe('PATCH /api/hub/settings/privacy', () => {
    it('valid partial update -> 200, flips only the given fields and persists them', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/hub/settings/privacy')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ showPurchases: false, showFollowing: false })
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: USER_CREATOR_BASIC,
        showPurchases: false,
        showFollowing: false,
        showSavedItems: true,
        showInMemberLists: true,
      });

      const persisted = await prisma.privacySettings.findUnique({
        where: { userWawuId: USER_CREATOR_BASIC },
      });
      expect(persisted).toMatchObject({ showPurchases: false, showFollowing: false });

      // Restore, so this test is re-runnable and doesn't leak state.
      await prisma.privacySettings.update({
        where: { userWawuId: USER_CREATOR_BASIC },
        data: { showPurchases: true, showFollowing: true },
      });
    });

    it('valid empty-object update -> 200, no fields change', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/hub/settings/privacy')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .send({})
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: USER_PLAIN,
        showPurchases: true,
        showSavedItems: true,
        showFollowing: true,
        showInMemberLists: true,
      });
    });

    it('400s on a non-boolean field value', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/hub/settings/privacy')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .send({ showPurchases: 'yes' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/hub/settings/privacy')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .send({ showPurchases: true, cashOutEnabled: true })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('missing auth -> 401', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/hub/settings/privacy')
        .send({ showPurchases: false })
        .expect(401);
      expect(res.body.data).toBeNull();
    });
  });
});

/**
 * The mock WAWU ID's /auth/login only knows its three seeded identifiers,
 * so exercising the lazy-create path (a wawuUserId with no PrivacySettings
 * row yet, but still a real WAWU-ID-shaped user) needs a 4th signed token.
 * Mints via the same private key the mock service signs with, over the
 * same claim shape (conventions.md's WawuJwtClaims) — still verified for
 * real by this backend's JWKS-backed strategy, only the *issuer* is the
 * local test double per the documented local-test-environment gap.
 */
async function mintTokenFor(sub: string): Promise<string> {
  const jwt = await import('jsonwebtoken');
  const fs = await import('fs');
  const path = await import('path');
  const privateKey = fs.readFileSync(
    path.join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `fresh-${sub}@test.wawu.dev`,
      phone: '+2348000009999',
      firstName: 'Fresh',
      lastName: 'User',
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
