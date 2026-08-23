// Run against wawu_hub_test — see README "Running the tests"; always via
// `npm run test:contract`, never bare jest.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

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
import { CreatorDiscoveryModule } from '../creator-discovery.module';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

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
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/**
 * GET /creators — the endpoint whose absence made the consumer app invent
 * people.
 *
 * Envelope note: ResponseInterceptor puts a paginated result's rows directly
 * in `data` and the counts in a sibling `pagination` — NOT `data.items`. Its whole job is to return REAL accounts, so the assertions are
 * about identity being real and resolved, not merely about a 200.
 */
describe('CreatorDiscovery (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let plainToken: string;

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        CreatorDiscoveryModule,
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
    plainToken = await login('user@test.wawu.dev');
  }, 40000);

  afterAll(async () => {
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  it('returns real seeded creators, not fabricated ones', async () => {
    const res = await request(app.getHttpServer()).get('/creators').expect(200);

    const ids = res.body.data.map(
      (c: { wawuId: string }) => c.wawuId,
    ) as string[];
    expect(ids).toEqual(
      expect.arrayContaining([USER_CREATOR_BASIC, USER_CREATOR_PRO]),
    );
    // The plain user is not a creator and must not appear in a creator list.
    expect(ids).not.toContain(USER_PLAIN);
    // Every id is a real WAWU ID uuid — the mock data used "wawu-adaeze".
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('resolves the real display name and badge tier from WAWU ID', async () => {
    const res = await request(app.getHttpServer()).get('/creators').expect(200);

    const pro = res.body.data.find(
      (c: { wawuId: string }) => c.wawuId === USER_CREATOR_PRO,
    );
    expect(pro).toBeDefined();
    // Name comes from WAWU ID, not from the handle it used to fall back to.
    expect(pro.name).toBe('Zainab Bello');
    // And the badge is that account's real tier, not a hardcoded "basic".
    expect(pro.verification).toBe('certified_professional');
  });

  it('counts only LIVE pieces', async () => {
    const res = await request(app.getHttpServer()).get('/creators').expect(200);

    const pro = res.body.data.find(
      (c: { wawuId: string }) => c.wawuId === USER_CREATOR_PRO,
    );
    const liveCount = await prisma.contentPiece.count({
      where: { creatorWawuId: USER_CREATOR_PRO, status: 'live' },
    });
    expect(pro.pieceCount).toBe(liveCount);
  });

  it('reports follow state for the caller, and false when anonymous', async () => {
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
    });
    await prisma.followRelationship.create({
      data: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
    });

    const authed = await request(app.getHttpServer())
      .get('/creators')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(200);
    const authedPro = authed.body.data.find(
      (c: { wawuId: string }) => c.wawuId === USER_CREATOR_PRO,
    );
    expect(authedPro.following).toBe(true);

    // Anonymous browsing is allowed and reports no follows rather than 401.
    const anon = await request(app.getHttpServer())
      .get('/creators')
      .expect(200);
    const anonPro = anon.body.data.find(
      (c: { wawuId: string }) => c.wawuId === USER_CREATOR_PRO,
    );
    expect(anonPro.following).toBe(false);
  });

  it('filters by interest, case-insensitively', async () => {
    const res = await request(app.getHttpServer())
      .get('/creators')
      .query({ category: 'MAKEUP' })
      .expect(200);

    const ids = res.body.data.map((c: { wawuId: string }) => c.wawuId);
    // USER_CREATOR_BASIC is seeded with ['beauty', 'makeup', 'tutorials'].
    expect(ids).toContain(USER_CREATOR_BASIC);
    // Zainab is not tagged makeup, so a filter that ignored the query would
    // fail here rather than quietly returning everyone.
    expect(ids).not.toContain(USER_CREATOR_PRO);
  });

  it('returns an empty page rather than everyone for an unmatched category', async () => {
    const res = await request(app.getHttpServer())
      .get('/creators')
      .query({ category: 'nothing-is-tagged-this' })
      .expect(200);

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('paginates with a stable order', async () => {
    const first = await request(app.getHttpServer())
      .get('/creators')
      .query({ page: 1, perPage: 1 })
      .expect(200);
    const second = await request(app.getHttpServer())
      .get('/creators')
      .query({ page: 2, perPage: 1 })
      .expect(200);

    expect(first.body.data).toHaveLength(1);
    expect(first.body.pagination.total).toBeGreaterThan(1);
    // Page 2 must not repeat page 1 — the failure an unordered query gives.
    expect(second.body.data[0].wawuId).not.toBe(first.body.data[0].wawuId);
  });

  it('400s on a perPage above the cap', async () => {
    await request(app.getHttpServer())
      .get('/creators')
      .query({ perPage: 500 })
      .expect(400);
  });
});
