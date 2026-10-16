import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { SearchResponseModule } from '../search-response.module';

// Seeded WAWU IDs / fixture data — mirror mock-wawu-id/server.js and
// prisma/seed.ts exactly (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // Adaeze — bought the CAC course, follows both creators
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Chidi — handle "chidi-creates", evgScore 1240
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Zainab — handle "zainab-pro", evgScore 5310

const CONTENT_CAC_COURSE = '10000000-0000-4000-8000-000000000001'; // "SEEDED: CAC in 7 days", paid, creator=PRO, purchased by USER_PLAIN
const CONTENT_MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002'; // "SEEDED: 10-Minute Owambe Makeup", free, creator=BASIC
const CONTENT_PDF_TEMPLATE = '10000000-0000-4000-8000-000000000003'; // "SEEDED: Invoice Template Pack", paid, creator=PRO, NOT purchased by USER_PLAIN

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

describe('SearchResponse (contract)', () => {
  let app: INestApplication;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainUserToken: string;

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

    plainUserToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
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
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /search', () => {
    it('400s when q is missing', async () => {
      await request(app.getHttpServer()).get('/search').expect(400);
    });

    it('400s when q is an empty string', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: '' })
        .expect(400);
    });

    it('finds the seeded CAC content by a substring of its title, case-insensitively, unauthenticated (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'cac in 7' })
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      const ids = res.body.data.content.map((c: { id: string }) => c.id);
      expect(ids).toContain(CONTENT_CAC_COURSE);
      // Unauthenticated: paid content is locked, fullAssetUrl redacted —
      // same product rule as ContentPieceService's own toResponse.
      const cac = res.body.data.content.find(
        (c: { id: string }) => c.id === CONTENT_CAC_COURSE,
      );
      expect(cac.fullAssetLocked).toBe(true);
      expect(cac.fullAssetUrl).toBeNull();
    });

    it('unlocks the purchased content for the authenticated buyer, but not the un-purchased paid content', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'SEEDED' })
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      const byId: Record<
        string,
        { fullAssetLocked: boolean; fullAssetUrl: string | null }
      > = {};
      for (const c of res.body.data.content) byId[c.id] = c;

      expect(byId[CONTENT_CAC_COURSE].fullAssetLocked).toBe(false);
      expect(byId[CONTENT_CAC_COURSE].fullAssetUrl).not.toBeNull();

      expect(byId[CONTENT_PDF_TEMPLATE].fullAssetLocked).toBe(true);
      expect(byId[CONTENT_PDF_TEMPLATE].fullAssetUrl).toBeNull();

      // Free content is never locked, purchase or not.
      expect(byId[CONTENT_MAKEUP_VIDEO].fullAssetLocked).toBe(false);
    });

    it('finds the seeded creator by a substring of their handle (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'zainab' })
        .expect(200);

      const ids = res.body.data.creators.map(
        (c: { wawuUserId: string }) => c.wawuUserId,
      );
      expect(ids).toContain(USER_CREATOR_PRO);
      const zainab = res.body.data.creators.find(
        (c: { wawuUserId: string }) => c.wawuUserId === USER_CREATOR_PRO,
      );
      // `tier` went with subscriptions (build brief B1: "There is no
      // subscription tier"), so the aggregate must not carry one at all --
      // a surviving tier here would be a fabricated plan. What the handle
      // search actually has to prove is that it matched on the handle, so
      // assert that instead of the plan that no longer exists.
      expect(zainab.tier).toBeUndefined();
      expect(zainab.handle).toBe('zainab-pro');
      // evgScore/followerCount are live aggregates over tables other
      // concurrently-running resource test suites legitimately mutate in
      // this shared wawu_hub_test database (follow/unfollow, EvgScore
      // recompute) — assert shape/non-negativity, not the seed's exact
      // snapshot values, to stay robust under parallel test runs.
      expect(typeof zainab.evgScore).toBe('number');
      expect(zainab.evgScore).toBeGreaterThanOrEqual(0);
      expect(typeof zainab.followerCount).toBe('number');
      expect(zainab.followerCount).toBeGreaterThanOrEqual(0);
    });

    it('finds the seeded creator by a substring of their bio (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'business consultant' })
        .expect(200);

      const ids = res.body.data.creators.map(
        (c: { wawuUserId: string }) => c.wawuUserId,
      );
      expect(ids).toContain(USER_CREATOR_PRO);
    });

    it('never matches a plain (non-creator) UserProfile in the creators array', async () => {
      // USER_PLAIN's seeded bio mentions "beauty tutorials" — a plain
      // account matching the text predicate must still be excluded.
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'beauty tutorials' })
        .expect(200);

      const ids = res.body.data.creators.map(
        (c: { wawuUserId: string }) => c.wawuUserId,
      );
      expect(ids).not.toContain(USER_PLAIN);
    });

    it('always returns communities: [] regardless of tab — Community (Wave 3) is not built yet', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'founders' })
        .expect(200);
      // The seeded Community is literally named "SEEDED: WAWU Founders
      // Circle" — if Community search were live this query would hit it.
      expect(res.body.data.communities).toEqual([]);
    });

    it('tab=content narrows to content only, with creators/communities present as empty arrays (documented envelope shape)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'SEEDED', tab: 'content' })
        .expect(200);

      expect(res.body.data.content.length).toBeGreaterThan(0);
      expect(res.body.data.creators).toEqual([]);
      expect(res.body.data.communities).toEqual([]);
    });

    it('tab=creators narrows to creators only', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'zainab', tab: 'creators' })
        .expect(200);

      expect(res.body.data.creators.length).toBeGreaterThan(0);
      expect(res.body.data.content).toEqual([]);
      expect(res.body.data.communities).toEqual([]);
    });

    it('tab=communities narrows to communities only — always empty (Wave 3 not built)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'founders', tab: 'communities' })
        .expect(200);

      expect(res.body.data.communities).toEqual([]);
      expect(res.body.data.content).toEqual([]);
      expect(res.body.data.creators).toEqual([]);
    });

    it('rejects an invalid tab value (400)', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'x', tab: 'events' })
        .expect(400);
    });

    it('returns empty arrays for a query that matches nothing (200, not 404)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'zzz-no-such-thing-zzz' })
        .expect(200);

      expect(res.body.data).toEqual({
        content: [],
        creators: [],
        communities: [],
      });
    });
  });

  describe('GET /search/suggestions', () => {
    it('works unauthenticated (200) and recentSearches is empty — no persisted search-history table exists yet (documented gap)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/suggestions')
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(res.body.data.recentSearches).toEqual([]);
      expect(Array.isArray(res.body.data.popularSearches)).toBe(true);
      expect(Array.isArray(res.body.data.suggestedCreators)).toBe(true);
    });

    it('recentSearches is also empty for an authenticated caller (documented gap, not auth-gated)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/suggestions')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data.recentSearches).toEqual([]);
    });

    it('ranks suggestedCreators by EvgScore, highest first, and includes both seeded creators', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/suggestions')
        .expect(200);

      const ids = res.body.data.suggestedCreators.map(
        (c: { wawuUserId: string }) => c.wawuUserId,
      );
      expect(ids).toContain(USER_CREATOR_PRO);
      expect(ids).toContain(USER_CREATOR_BASIC);
      // Zainab (5310) outranks Chidi (1240).
      expect(ids.indexOf(USER_CREATOR_PRO)).toBeLessThan(
        ids.indexOf(USER_CREATOR_BASIC),
      );
    });

    it('popularSearches surfaces titles of high-view live content (heuristic, documented)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/suggestions')
        .expect(200);

      // "SEEDED: 10-Minute Owambe Makeup" has the highest seeded view
      // count (1893) among live content, so it should be present.
      expect(res.body.data.popularSearches).toContain(
        'SEEDED: 10-Minute Owambe Makeup',
      );
    });
  });

  describe('GET /search/closest', () => {
    it('400s when q is missing', async () => {
      await request(app.getHttpServer()).get('/search/closest').expect(400);
    });

    it('broadens a multi-word query token-by-token to find a fuzzy match (200)', async () => {
      // Neither the full phrase nor "tutorial" alone substring-matches the
      // seeded title, but the "makeup" token does — proves the fallback is
      // genuinely token-broadened, not just a straight substring search.
      const res = await request(app.getHttpServer())
        .get('/search/closest')
        .query({ q: 'owambe makeup tutorial' })
        .expect(200);

      const ids = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(CONTENT_MAKEUP_VIDEO);
    });

    it('returns items: [] for a query with no token matches (200, not 404)', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/closest')
        .query({ q: 'zzz-nonexistent-zzz qqq-nope-qqq' })
        .expect(200);

      expect(res.body.data.items).toEqual([]);
    });

    it('works unauthenticated and returns paid content locked', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/closest')
        .query({ q: 'CAC' })
        .expect(200);

      const cac = res.body.data.items.find(
        (i: { id: string }) => i.id === CONTENT_CAC_COURSE,
      );
      expect(cac).toBeDefined();
      expect(cac.fullAssetLocked).toBe(true);
    });
  });
});
