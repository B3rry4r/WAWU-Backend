import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { FollowRelationshipModule } from '../follow-relationship.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic tier creator
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro tier creator
const NONEXISTENT_WAWU_ID = 'ffffffff-0000-4000-8000-000000000099';

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
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('FollowRelationship (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorProToken: string;

  beforeAll(async () => {
    // Reuse an already-running mock WAWU ID if present, otherwise spawn one
    // for this test run (conventions.md § Local test environment).
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
    creatorProToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        FollowRelationshipModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // Clean slate for the pair we exercise, so tests are order-independent.
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
    });
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('POST /creators/:wawuId/follow', () => {
    it('follows a creator for a valid request (200 shape)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/creators/${USER_CREATOR_BASIC}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual({ following: true });

      const stored = await prisma.followRelationship.findUnique({
        where: {
          followerWawuId_followingWawuId: {
            followerWawuId: USER_PLAIN,
            followingWawuId: USER_CREATOR_BASIC,
          },
        },
      });
      expect(stored).not.toBeNull();
    });

    it('is idempotent when following the same creator twice', async () => {
      const res = await request(app.getHttpServer())
        .post(`/creators/${USER_CREATOR_BASIC}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual({ following: true });
    });

    it('400s when trying to follow yourself', async () => {
      const res = await request(app.getHttpServer())
        .post(`/creators/${USER_PLAIN}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send()
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('404s when the target wawuId does not exist', async () => {
      const res = await request(app.getHttpServer())
        .post(`/creators/${NONEXISTENT_WAWU_ID}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send()
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('404s when the target wawuId is not a creator account', async () => {
      // USER_PLAIN is accountType "user", not "creator" — creatorProToken
      // attempting to follow a non-creator account.
      const res = await request(app.getHttpServer())
        .post(`/creators/${USER_PLAIN}/follow`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send()
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/creators/${USER_CREATOR_BASIC}/follow`)
        .send()
        .expect(401);
    });
  });

  describe('DELETE /creators/:wawuId/follow', () => {
    it('unfollows a creator for a valid request (200 shape)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/creators/${USER_CREATOR_BASIC}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ following: false });

      const stored = await prisma.followRelationship.findUnique({
        where: {
          followerWawuId_followingWawuId: {
            followerWawuId: USER_PLAIN,
            followingWawuId: USER_CREATOR_BASIC,
          },
        },
      });
      expect(stored).toBeNull();
    });

    it('is idempotent when unfollowing a creator not currently followed', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/creators/${USER_CREATOR_PRO}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ following: false });
    });

    it('404s when the target wawuId does not exist', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/creators/${NONEXISTENT_WAWU_ID}/follow`)
        .set('Authorization', `Bearer ${userToken}`)
        .send()
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .delete(`/creators/${USER_CREATOR_BASIC}/follow`)
        .send()
        .expect(401);
    });
  });
});
