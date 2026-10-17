import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AccountModule } from '../../account/account.module';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../../account/wawu-id-account.gateway';
import { CommunityModule } from '../../community/community.module';
import { SearchResponseModule } from '../search-response.module';
import {
  normaliseSearch,
  SearchHistoryService,
} from '../search-history.service';
import { joinMembers } from './popular-members';

/**
 * EXPLORE-05 round 2.
 *
 * 1. The new answers are opt-in: GET /search fills `communities` and GET
 *    /search/suggestions fills `recentSearches` only for a request that
 *    carries `include`, so the web (which sends none) gets what it always got.
 * 2. GET /search/popular leaves out the searches of an account whose deletion
 *    is scheduled.
 * 3. POST /search/recent says what is wrong with a `q` that is not text.
 *
 * Round 3 replaced the old rule 3 (a list of forbidden spellings) with an
 * allow-list of public names; its specs are search-popular-allowlist and
 * popular-name.
 *
 * Rows made here carry MARK in their text or their ids, so the spec holds on a
 * database other suites have used.
 */
const MARK = 'ex05r';
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_BASIC = '00000000-0000-4000-8000-000000000002';
const MOCK_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_ID = `http://localhost:${MOCK_ID_PORT}`;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_ID}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Search, round 2 (EXPLORE-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let history: SearchHistoryService;
  let plain: string;
  let basic: string;
  let hadPushStop = false;
  const roomIds: string[] = [];
  const gateway = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const popular = async () => {
    history.resetPopularCache(); // the answer is kept for 60 s otherwise
    return data<{ items: string[] }>(
      await http().get('/api/hub/search/popular'),
    ).items;
  };
  const room = async (name: string) => {
    const r = await prisma.community.create({
      data: { name, hostWawuId: USER_BASIC, kind: 'open', description: 'x' },
    });
    roomIds.push(r.id);
    // R-57: a room is a popular name once it has enough members.
    await joinMembers(prisma, r.id, MARK);
    return r.id;
  };
  /** `people` synthetic accounts each searched `text`, stored as the Hub stores it. */
  const seed = (text: string, people: number, tag: string) => {
    const n = normaliseSearch(text);
    return prisma.searchHistory.createMany({
      data: Array.from({ length: people }, (_, i) => ({
        userWawuId: `${MARK}-u${i}-${tag}`,
        queryKey: n.queryKey,
        query: n.query,
        searchedAt: new Date(Date.now() - i * 1000),
      })),
    });
  };

  async function cleanUp() {
    await prisma.searchHistory.deleteMany({
      where: {
        OR: [
          { queryKey: { startsWith: MARK } },
          { userWawuId: { startsWith: MARK } },
          { query: { startsWith: MARK } },
        ],
      },
    });
    await prisma.community.deleteMany({
      where: { OR: [{ id: { in: roomIds } }, { name: { contains: MARK } }] },
    });
    await prisma.contentPiece.deleteMany({
      where: { slug: { startsWith: MARK } },
    });
    const profiles = await prisma.userProfile.findMany({
      where: { wawuUserId: { startsWith: `${MARK}-` } },
      select: { wawuUserId: true },
    });
    const ids = profiles.map((p) => p.wawuUserId);
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: ids } } });
  }

  beforeAll(async () => {
    [plain, basic] = await Promise.all([
      login('user@test.wawu.dev'),
      login('creator-basic@test.wawu.dev'),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
        CommunityModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
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
    prisma = app.get(PrismaService);
    history = app.get(SearchHistoryService);
    hadPushStop =
      (await prisma.pushStoppedAccount.count({
        where: { userWawuId: USER_PLAIN },
      })) > 0;
    await cleanUp();
  }, 60000);

  afterAll(async () => {
    await cleanUp();
    if (!hadPushStop)
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: USER_PLAIN },
      });
    await app?.close();
  });

  describe('opt-in answers (the web sends no include)', () => {
    const NAME = `${MARK} Opt Room`;
    beforeAll(async () => {
      await room(NAME);
    });

    it('GET /search leaves communities empty on every tab without include', async () => {
      for (const tab of [undefined, 'all', 'communities', 'content']) {
        const res = await http()
          .get('/api/hub/search')
          .query({ q: NAME, ...(tab ? { tab } : {}) });
        expect(res.status).toBe(200);
        const body = data<Record<string, unknown>>(res);
        expect(Object.keys(body).sort()).toEqual([
          'communities',
          'content',
          'creators',
        ]);
        expect(body.communities).toEqual([]);
      }
    });

    it('GET /search fills communities with include=communities on tab all and communities only', async () => {
      for (const [tab, filled] of [
        [undefined, true],
        ['all', true],
        ['communities', true],
        ['content', false],
        ['creators', false],
      ] as const) {
        const res = await http()
          .get('/api/hub/search')
          .query({ q: NAME, include: 'communities', ...(tab ? { tab } : {}) });
        expect(res.status).toBe(200);
        const names = data<{ communities: { name: string }[] }>(
          res,
        ).communities.map((c) => c.name);
        expect(names.includes(NAME)).toBe(filled);
      }
    });

    it('GET /search refuses an include it does not know', async () => {
      for (const include of ['recent', 'everything', '']) {
        const res = await http()
          .get('/api/hub/search')
          .query({ q: NAME, include });
        expect(res.status).toBe(400);
      }
    });

    it('GET /search/suggestions leaves recentSearches empty without include', async () => {
      await http()
        .post('/api/hub/search/recent')
        .set(auth(plain))
        .send({ q: `${MARK} opt recent` });
      const without = data<{ recentSearches: string[] }>(
        await http().get('/api/hub/search/suggestions').set(auth(plain)),
      );
      expect(without.recentSearches).toEqual([]);
      const withInclude = data<{ recentSearches: string[] }>(
        await http()
          .get('/api/hub/search/suggestions')
          .query({ include: 'recent' })
          .set(auth(plain)),
      );
      expect(withInclude.recentSearches).toContain(`${MARK} opt recent`);
    });

    it('GET /search/suggestions with include=recent is empty when signed out, and refuses an unknown include', async () => {
      const signedOut = await http()
        .get('/api/hub/search/suggestions')
        .query({ include: 'recent' });
      expect(signedOut.status).toBe(200);
      expect(
        data<{ recentSearches: string[] }>(signedOut).recentSearches,
      ).toEqual([]);
      for (const query of [
        { include: 'communities' },
        { include: 'x' },
        'include=recent&include=recent',
      ]) {
        const res = await http()
          .get('/api/hub/search/suggestions')
          .query(query);
        expect(res.status).toBe(400);
      }
    });

    it('GET /search/suggestions ignores any other query it is sent, as it did', async () => {
      const res = await http()
        .get('/api/hub/search/suggestions')
        .query({ whatever: '1' })
        .set(auth(plain));
      expect(res.status).toBe(200);
    });
  });

  describe('POST /search/recent says what is wrong with q', () => {
    const say = async (body: unknown) => {
      const res = await http()
        .post('/api/hub/search/recent')
        .set(auth(plain))
        .send(body as object);
      return {
        status: res.status,
        message: (res.body as { message: string }).message,
      };
    };

    it('says q is required when it is missing or null', async () => {
      expect(await say({})).toEqual({ status: 400, message: 'q is required' });
      expect(await say({ q: null })).toEqual({
        status: 400,
        message: 'q is required',
      });
    });

    it('says q must be text for a number, an array, an object or a boolean', async () => {
      for (const q of [5, 0, ['a'], [], { a: 1 }, true]) {
        expect(await say({ q })).toEqual({
          status: 400,
          message: 'q must be text',
        });
      }
    });

    it('still says empty for an empty text and too long for a long one', async () => {
      const empty = await say({ q: '' });
      expect(empty.status).toBe(400);
      expect(empty.message).toMatch(/empty/);
      const long = await say({ q: 'a'.repeat(101) });
      expect(long.status).toBe(400);
      expect(long.message).toMatch(/shorter than or equal to 100/);
    });
  });

  describe('a deleted account does not count', () => {
    const TEXT = `${MARK} delta lantern`;
    const SECOND = `${MARK} epsilon lantern`;

    beforeAll(async () => {
      // popular shows the name of a public thing, so each text is a room's name
      await room(TEXT);
      await room(SECOND);
    });

    it('drops a text at once when one of its three people schedules the deletion', async () => {
      // Three accounts: plain and basic search it for real, a third is a row.
      for (const t of [plain, basic])
        await http()
          .post('/api/hub/search/recent')
          .set(auth(t))
          .send({ q: TEXT });
      await seed(TEXT, 1, 'delta');
      expect(await popular()).toContain(TEXT);

      const del = await http().delete('/api/hub/account').set(auth(plain));
      expect(del.status).toBe(200);
      // plain's row is still there (kept until the purge), and not counted.
      expect(
        await prisma.searchHistory.count({
          where: { userWawuId: USER_PLAIN, queryKey: TEXT },
        }),
      ).toBe(1);
      expect(await popular()).not.toContain(TEXT);
    });

    it('keeps a text that three other people still have', async () => {
      // plain (deleted) typed it too, in capitals; the room's own name shows.
      await seed(SECOND, 3, 'epsilon');
      await prisma.searchHistory.create({
        data: {
          userWawuId: USER_PLAIN,
          queryKey: SECOND,
          query: SECOND.toUpperCase(),
          searchedAt: new Date(),
        },
      });
      const list = await popular();
      expect(list).toContain(SECOND);
      expect(list).not.toContain(SECOND.toUpperCase());
    });

    it('counts the account again when the deletion is cancelled (the mark is removed)', async () => {
      expect(await popular()).not.toContain(TEXT);
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: USER_PLAIN },
      });
      expect(await popular()).toContain(TEXT);
      await prisma.pushStoppedAccount.create({
        data: { userWawuId: USER_PLAIN },
      });
      expect(await popular()).not.toContain(TEXT);
    });
  });
});
