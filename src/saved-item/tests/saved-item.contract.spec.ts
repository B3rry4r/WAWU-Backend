// Contract test for the SavedItem resource (registry.json § SavedItem):
//   GET /users/me/saved — roles: any
//
// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief). Auth is exercised for real: this spec spins up the repo's
// mock-wawu-id service (mock-wawu-id/server.js) as a real HTTP process, logs
// in as seeded WAWU IDs to get real RS256 access tokens, and lets
// WawuJwtStrategy verify them over HTTP via JWKS — no minted/injected tokens.
//
// Note: creating/removing a save (POST/DELETE /content/:id/save) is owned
// by the ContentPiece resource, a different build agent — this spec only
// exercises the read side and seeds its own fixture rows directly via
// Prisma for the assertions that need them.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { SavedItemModule } from '../saved-item.module';

const MOCK_WAWU_ID_PORT = 4001;
const MOCK_WAWU_ID_URL = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// Seeded wawuUserIds — mock-wawu-id/server.js § USERS, mirrored by prisma/seed.ts.
const PLAIN_USER = { email: 'user@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000001' };
const CREATOR_PRO = { email: 'creator-pro@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000003' };

// Seeded ContentPiece ids (prisma/seed.ts).
const CONTENT_CAC_COURSE = '10000000-0000-4000-8000-000000000001'; // prisma/seed.ts SavedItem fixture: USER_PLAIN saved this
const CONTENT_MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002';

let mockWawuId: ChildProcessWithoutNullStreams | undefined;

async function waitForMockWawuId(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function ensureMockWawuIdRunning(): Promise<void> {
  try {
    const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
    if (res.ok) return; // already running (e.g. left up by a prior/sibling spec run)
  } catch {
    // not running — start it below
  }
  mockWawuId = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '../../../mock-wawu-id'),
    env: { ...process.env, MOCK_WAWU_ID_PORT: String(MOCK_WAWU_ID_PORT) },
    stdio: 'pipe',
  });
  await waitForMockWawuId();
}

async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email }),
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('SavedItem contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plainUserToken: string;
  let creatorProToken: string;

  beforeAll(async () => {
    await ensureMockWawuIdRunning();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, SavedItemModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    [plainUserToken, creatorProToken] = await Promise.all([tokenFor(PLAIN_USER.email), tokenFor(CREATOR_PRO.email)]);

    // Guarantee the fixture prisma/seed.ts plants (USER_PLAIN saved
    // CONTENT_CAC_COURSE) exists regardless of the shared test DB's current
    // seed/reset state, plus a second save so pagination has >1 row to work
    // with.
    await prisma.savedItem.upsert({
      where: { userWawuId_contentId: { userWawuId: PLAIN_USER.sub, contentId: CONTENT_CAC_COURSE } },
      update: {},
      create: { userWawuId: PLAIN_USER.sub, contentId: CONTENT_CAC_COURSE },
    });
    await prisma.savedItem.upsert({
      where: { userWawuId_contentId: { userWawuId: PLAIN_USER.sub, contentId: CONTENT_MAKEUP_VIDEO } },
      update: {},
      create: { userWawuId: PLAIN_USER.sub, contentId: CONTENT_MAKEUP_VIDEO },
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
    mockWawuId?.kill();
  });

  describe('GET /users/me/saved', () => {
    it('valid request → 200 with the PaginatedList<SavedItem> shape, scoped to the caller', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me/saved')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 20, total: expect.any(Number) }),
      );
      // every row belongs to the caller, never another user's saves
      for (const item of res.body.data) {
        expect(item.userWawuId).toBe(PLAIN_USER.sub);
      }
      const cacSave = res.body.data.find((s: { contentId: string }) => s.contentId === CONTENT_CAC_COURSE);
      expect(cacSave).toBeDefined();
      expect(cacSave.id).toEqual(expect.any(String));
      expect(cacSave.savedAt).toEqual(expect.any(String));
    });

    it('supports pagination query params (perPage=1 returns exactly 1 row, total reflects the full count)', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me/saved?page=1&perPage=1')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 1, total: expect.any(Number) }),
      );
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('kind=guide (a kind this backend has no saved-item table for) → 200 with a genuine empty page, not an error', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me/saved?kind=guide')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 20, total: 0, nextPage: null }),
      );
    });

    it('a caller with no saved content gets only their own (empty-of-others) scope, never another user’s rows', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me/saved')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      for (const item of res.body.data) {
        expect(item.userWawuId).toBe(CREATOR_PRO.sub);
      }
    });

    it('invalid payload (perPage over the conventions.md max of 100) → 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me/saved?perPage=999')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('invalid payload (kind outside the content|guide|product enum) → 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/me/saved?kind=not-a-real-kind')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('missing auth → 401', async () => {
      await request(app.getHttpServer()).get('/users/me/saved').expect(401);
    });
  });
});
