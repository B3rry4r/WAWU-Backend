import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { UserProfileModule } from '../user-profile.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic creator, kyc pending
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro creator, kyc approved

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('UserProfile (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorBasicToken: string;
  let creatorProToken: string;

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    userToken = await login('user@test.wawu.dev');
    creatorBasicToken = await login('creator-basic@test.wawu.dev');
    creatorProToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /users/me', () => {
    it('returns the merged UserProfile + JWT claims for a seeded profile (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          wawuUserId: USER_PLAIN,
          accountType: 'user',
          handle: 'adaeze',
          interests: expect.arrayContaining(['beauty']),
          email: 'user@test.wawu.dev', // JWT claim merged in
          sub: USER_PLAIN,
        }),
      );
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/users/me').expect(401);
    });
  });

  describe('PATCH /users/me', () => {
    it('creates the profile row on first call for a caller with no existing row (registry note)', async () => {
      // The 3 mock WAWU ID identities are fixed, so a real never-before-seen
      // token can't be minted — instead, delete the seeded row for an
      // otherwise-real, JWKS-verified caller to exercise the genuine
      // create-on-first-PATCH path end to end, then restore it.
      const original = await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: USER_CREATOR_BASIC },
      });
      await prisma.userProfile.delete({
        where: { wawuUserId: USER_CREATOR_BASIC },
      });

      try {
        const getRes = await request(app.getHttpServer())
          .get('/users/me')
          .set('Authorization', `Bearer ${creatorBasicToken}`)
          .expect(200);
        expect(getRes.body.data).toEqual(
          expect.objectContaining({
            wawuUserId: USER_CREATOR_BASIC,
            accountType: null,
            createdAt: null,
            interests: [],
          }),
        );

        const patchRes = await request(app.getHttpServer())
          .patch('/users/me')
          .set('Authorization', `Bearer ${creatorBasicToken}`)
          .send({ accountType: 'creator', bio: 'Freshly onboarded' })
          .expect(200);

        expect(patchRes.body.data).toEqual(
          expect.objectContaining({
            wawuUserId: USER_CREATOR_BASIC,
            accountType: 'creator',
            bio: 'Freshly onboarded',
            interests: [],
          }),
        );

        const stored = await prisma.userProfile.findUnique({
          where: { wawuUserId: USER_CREATOR_BASIC },
        });
        expect(stored).not.toBeNull();
      } finally {
        await prisma.userProfile.upsert({
          where: { wawuUserId: USER_CREATOR_BASIC },
          update: original,
          create: original,
        });
      }
    });

    it('updates bio, interests, and handle for the caller (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          bio: 'Updated bio via contract test',
          interests: ['beauty', 'skincare', 'tech'],
        })
        .expect(200);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          wawuUserId: USER_PLAIN,
          bio: 'Updated bio via contract test',
          interests: ['beauty', 'skincare', 'tech'],
        }),
      );

      const stored = await prisma.userProfile.findUnique({
        where: { wawuUserId: USER_PLAIN },
      });
      expect(stored?.bio).toBe('Updated bio via contract test');

      // Restore original seeded state so other tests / re-runs stay stable.
      await prisma.userProfile.update({
        where: { wawuUserId: USER_PLAIN },
        data: {
          bio: 'Lover of Ankara prints and good jollof. Here for the beauty tutorials.',
          interests: ['beauty', 'fashion', 'skincare'],
        },
      });
    });

    it('rejects a handle already taken by another account (400)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ handle: 'zainab-pro' }) // seeded handle of USER_CREATOR_PRO
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on an invalid payload (accountType outside the enum)', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ accountType: 'admin' })
        .expect(400);
    });

    it('400s on a payload with a non-whitelisted field (websiteUrl is read-only via this endpoint)', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ websiteUrl: 'https://example.com' })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .send({ bio: 'no auth' })
        .expect(401);
    });
  });

  describe('GET /users/:wawuId/public-profile', () => {
    it('returns the merged CreatorProfile aggregate for a seeded creator (200)', async () => {
      const [
        expectedContentCount,
        expectedFollowerCount,
        expectedCommunityCount,
        expectedEvg,
      ] = await Promise.all([
        prisma.contentPiece.count({
          where: { creatorWawuId: USER_CREATOR_PRO, status: 'live' },
        }),
        prisma.followRelationship.count({
          where: { followingWawuId: USER_CREATOR_PRO },
        }),
        prisma.community.count({ where: { hostWawuId: USER_CREATOR_PRO } }),
        prisma.evgScore.findUnique({
          where: { creatorWawuId: USER_CREATOR_PRO },
        }),
      ]);

      // Any authenticated caller can view it (roles: ["any"]) — exercised
      // here as the pro creator viewing their own public profile.
      const res = await request(app.getHttpServer())
        .get(`/users/${USER_CREATOR_PRO}/public-profile`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          wawuUserId: USER_CREATOR_PRO,
          handle: 'zainab-pro',
          tier: 'pro',
          evgScore: expectedEvg?.score ?? 0,
          contentCount: expectedContentCount,
          followerCount: expectedFollowerCount,
          communityCount: expectedCommunityCount,
        }),
      );
    });

    it('404s for a wawuId with no UserProfile row at all', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${randomUUID()}/public-profile`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('404s for a plain user account (no CreatorState — not a creator)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${USER_PLAIN}/public-profile`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/users/${USER_CREATOR_PRO}/public-profile`)
        .expect(401);
    });
  });
});
