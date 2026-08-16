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
import { CommentModule } from '../comment.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user, author of the seeded comment
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';

const SEEDED_CONTENT_ID = '10000000-0000-4000-8000-000000000002'; // seeded-10-minute-owambe-makeup
const SEEDED_COMMENT_ID = '12000000-0000-4000-8000-000000000001';
const NONEXISTENT_CONTENT_ID = 'ffffffff-0000-4000-8000-000000000099';

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

describe('Comment (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorToken: string;

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
    creatorToken = await login('creator-basic@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, CommentModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
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

  describe('GET /content/:id/comments', () => {
    it('returns the paginated list of comments for valid content (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${SEEDED_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 20, total: expect.any(Number) }),
      );
      const seeded = res.body.data.find((c: { id: string }) => c.id === SEEDED_COMMENT_ID);
      expect(seeded).toBeDefined();
      expect(seeded.contentId).toBe(SEEDED_CONTENT_ID);
      expect(seeded.authorWawuId).toBe(USER_PLAIN);
    });

    it('404s for content that does not exist (invalid request)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${NONEXISTENT_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get(`/content/${SEEDED_CONTENT_ID}/comments`).expect(401);
    });
  });

  describe('POST /content/:id/comments', () => {
    it('creates a comment for a valid request (201/200 shape)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${SEEDED_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ text: 'Great tutorial, thank you!' });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          contentId: SEEDED_CONTENT_ID,
          authorWawuId: USER_CREATOR_BASIC,
          text: 'Great tutorial, thank you!',
          replyToId: null,
        }),
      );
      expect(res.body.data.id).toEqual(expect.any(String));

      const stored = await prisma.comment.findUnique({ where: { id: res.body.data.id } });
      expect(stored).not.toBeNull();
    });

    it('supports replying to an existing comment on the same content', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${SEEDED_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'Totally agree!', replyToId: SEEDED_COMMENT_ID });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.replyToId).toBe(SEEDED_COMMENT_ID);
    });

    it('400s on an invalid payload (empty text)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${SEEDED_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: '' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post(`/content/${SEEDED_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'hello', likes: 999 })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/content/${SEEDED_CONTENT_ID}/comments`)
        .send({ text: 'no auth' })
        .expect(401);
    });
  });
});
