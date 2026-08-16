// Contract test for the BlockedAccount resource (registry.json § BlockedAccount):
//   GET    /settings/privacy/blocked      — roles: any
//   DELETE /settings/privacy/blocked/:id  — roles: any
//
// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief). Auth is exercised for real: this spec spins up the repo's
// mock-wawu-id service (mock-wawu-id/server.js) as a real HTTP process, logs
// in as seeded WAWU IDs to get real RS256 access tokens, and lets
// WawuJwtStrategy verify them over HTTP via JWKS — no minted/injected tokens.
//
// Note: the registry contract for BlockedAccount carries no create endpoint
// anywhere (checked the full registry.json — no resource exposes a "block
// this account" POST). Same pattern as SavedItem's read-only-here split:
// this spec seeds its own fixture rows directly via Prisma for the
// assertions that need them.

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
import { BlockedAccountModule } from '../blocked-account.module';

const MOCK_WAWU_ID_PORT = 4001;
const MOCK_WAWU_ID_URL = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// Seeded wawuUserIds — mock-wawu-id/server.js § USERS, mirrored by prisma/seed.ts.
const PLAIN_USER = { email: 'user@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000001' };
const CREATOR_BASIC = { email: 'creator-basic@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000002' };
const CREATOR_PRO = { email: 'creator-pro@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000003' };

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

describe('BlockedAccount contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plainUserToken: string;
  let creatorProToken: string;

  let plainUserBlockOfBasicId: string;
  let plainUserBlockOfProId: string;
  let creatorProBlockId: string;

  beforeAll(async () => {
    await ensureMockWawuIdRunning();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, BlockedAccountModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    [plainUserToken, creatorProToken] = await Promise.all([tokenFor(PLAIN_USER.email), tokenFor(CREATOR_PRO.email)]);

    // Clean slate for the rows this spec owns, so runs are order-independent.
    await prisma.blockedAccount.deleteMany({
      where: {
        OR: [
          { userWawuId: PLAIN_USER.sub, blockedWawuId: { in: [CREATOR_BASIC.sub, CREATOR_PRO.sub] } },
          { userWawuId: CREATOR_PRO.sub, blockedWawuId: PLAIN_USER.sub },
        ],
      },
    });

    const blockA = await prisma.blockedAccount.create({
      data: { userWawuId: PLAIN_USER.sub, blockedWawuId: CREATOR_BASIC.sub },
    });
    plainUserBlockOfBasicId = blockA.id;

    const blockB = await prisma.blockedAccount.create({
      data: { userWawuId: PLAIN_USER.sub, blockedWawuId: CREATOR_PRO.sub },
    });
    plainUserBlockOfProId = blockB.id;

    const blockC = await prisma.blockedAccount.create({
      data: { userWawuId: CREATOR_PRO.sub, blockedWawuId: PLAIN_USER.sub },
    });
    creatorProBlockId = blockC.id;
  }, 30000);

  afterAll(async () => {
    await app?.close();
    mockWawuId?.kill();
  });

  describe('GET /settings/privacy/blocked', () => {
    it('valid request → 200 with the PaginatedList<BlockedAccount> shape, scoped to the caller', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 20, total: expect.any(Number) }),
      );
      // every row belongs to the caller, never another user's blocks
      for (const item of res.body.data) {
        expect(item.userWawuId).toBe(PLAIN_USER.sub);
      }
      const basicBlock = res.body.data.find((b: { blockedWawuId: string }) => b.blockedWawuId === CREATOR_BASIC.sub);
      expect(basicBlock).toBeDefined();
      expect(basicBlock.id).toEqual(expect.any(String));
      expect(basicBlock.blockedAt).toEqual(expect.any(String));
    });

    it('supports pagination query params (perPage=1 returns exactly 1 row, total reflects the full count)', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/privacy/blocked?page=1&perPage=1')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 1, total: expect.any(Number) }),
      );
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('a different caller gets only their own (empty-of-others) scope, never another user’s rows', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      for (const item of res.body.data) {
        expect(item.userWawuId).toBe(CREATOR_PRO.sub);
      }
      expect(res.body.data.some((b: { id: string }) => b.id === creatorProBlockId)).toBe(true);
    });

    it('invalid payload (perPage over the conventions.md max of 100) → 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/privacy/blocked?perPage=999')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('missing auth → 401', async () => {
      await request(app.getHttpServer()).get('/settings/privacy/blocked').expect(401);
    });
  });

  describe('DELETE /settings/privacy/blocked/:id', () => {
    it('valid request → 200, void response, row is gone', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/settings/privacy/blocked/${plainUserBlockOfProId}`)
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200 });
      expect(res.body.data).toBeNull();

      const stored = await prisma.blockedAccount.findUnique({ where: { id: plainUserBlockOfProId } });
      expect(stored).toBeNull();
    });

    it('404s when the id does not exist', async () => {
      const res = await request(app.getHttpServer())
        .delete('/settings/privacy/blocked/ffffffff-0000-4000-8000-000000000099')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('404s (never someone else’s row) when the id belongs to a different user', async () => {
      // creatorProBlockId belongs to CREATOR_PRO, not PLAIN_USER — plainUserToken
      // must not be able to unblock it, and must not learn it exists.
      const res = await request(app.getHttpServer())
        .delete(`/settings/privacy/blocked/${creatorProBlockId}`)
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();

      const stillThere = await prisma.blockedAccount.findUnique({ where: { id: creatorProBlockId } });
      expect(stillThere).not.toBeNull();
    });

    it('missing auth → 401', async () => {
      await request(app.getHttpServer())
        .delete(`/settings/privacy/blocked/${plainUserBlockOfBasicId}`)
        .expect(401);
    });
  });
});
