import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CommunityModule } from '../../community/community.module';
import { SearchResponseModule } from '../search-response.module';
import {
  normaliseSearch,
  SearchHistoryService,
} from '../search-history.service';
import { REFUSED_BY_CHARACTER_RULE } from './popular-forms';

/**
 * EXPLORE-05 round 3. GET /search/popular shows an entry only when its text
 * EQUALS the name of a public thing a signed-out visitor can find today (a
 * content title, a creator's handle with a creator state, a community name, a
 * category name), and only when that name is made of letters, spaces and
 * `' & -` with at most four digits. The text shown is the thing's own name,
 * never a searcher's spelling. One query ranks it, and the answer is kept for
 * 60 seconds in the process.
 *
 * Rows made here carry MARK (letters only, so a name made from it holds no
 * digit) in their text, slug or ids, so the spec holds on a database other
 * suites have used.
 */
const MARK = 'exallow';
const HOST = '00000000-0000-4000-8000-000000000002';

describe('GET /search/popular: only the names of public things (EXPLORE-05 round 3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let history: SearchHistoryService;
  const roomIds: string[] = [];
  let seedTag = 0;

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  /** The answer as the route gives it, with the 60 s cache emptied first. */
  const popular = async (): Promise<string[]> => {
    history.resetPopularCache();
    return data<{ items: string[] }>(
      await http().get('/api/hub/search/popular'),
    ).items;
  };
  const room = async (name: string) => {
    const r = await prisma.community.create({
      data: { name, hostWawuId: HOST, kind: 'open', description: 'x' },
    });
    roomIds.push(r.id);
    return r.id;
  };
  const piece = (
    slug: string,
    title: string,
    category = 'Music',
    status: 'live' | 'pending' = 'live',
  ) =>
    prisma.contentPiece.create({
      data: {
        slug: `${MARK}-${slug}`,
        creatorWawuId: HOST,
        contentType: 'video',
        title,
        description: 'About',
        category,
        accessType: 'paid',
        price: 500,
        previewAssetUrl: 'https://img.example.com/p.png',
        status,
      },
    });
  /** `people` accounts each searched `text`, stored as the Hub stores it. */
  const seed = (text: string, people: number, ageSeconds = 0) => {
    const n = normaliseSearch(text);
    const tag = seedTag++;
    return prisma.searchHistory.createMany({
      data: Array.from({ length: people }, (_, i) => ({
        userWawuId: `${MARK}-u${i}-${tag}`,
        queryKey: n.queryKey,
        query: n.query,
        searchedAt: new Date(Date.now() - (ageSeconds + i) * 1000),
      })),
    });
  };

  async function cleanUp() {
    await prisma.searchHistory.deleteMany({
      where: { userWawuId: { startsWith: `${MARK}-` } },
    });
    await prisma.community.deleteMany({
      where: { OR: [{ id: { in: roomIds } }, { name: { startsWith: MARK } }] },
    });
    await prisma.contentPiece.deleteMany({
      where: { slug: { startsWith: `${MARK}-` } },
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
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
        CommunityModule,
      ],
    }).compile();
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
    await cleanUp();
  }, 60000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
  });

  describe('what is still shown', () => {
    const TITLE = `${MARK} Afrobeats`;
    const HANDLE = `${MARK}okafor`;
    const ROOM = `${MARK} Lagos Photographers`;
    const CATEGORY = `${MARK} Gospel`;
    const NUMBERED = `${MARK} Top 10 Songs`;

    beforeAll(async () => {
      await piece('afro', TITLE, CATEGORY);
      await piece('numbered', NUMBERED);
      await prisma.userProfile.create({
        data: {
          wawuUserId: `${MARK}-c1`,
          accountType: 'creator',
          handle: HANDLE,
          bio: 'bio',
        },
      });
      await prisma.creatorState.create({ data: { wawuUserId: `${MARK}-c1` } });
      await room(ROOM);
      // Searched in lower case by three people each, as people type.
      for (const text of [TITLE, HANDLE, ROOM, CATEGORY])
        await seed(text.toLowerCase(), 3);
    });

    it('shows a content title, a creator handle, a community name and a category name', async () => {
      expect(await popular()).toEqual(
        expect.arrayContaining([TITLE, HANDLE, ROOM, CATEGORY]),
      );
    });

    it("shows the thing's own name, never a searcher's spelling", async () => {
      const list = await popular();
      expect(list).not.toContain(TITLE.toLowerCase());
      expect(list).not.toContain(ROOM.toUpperCase());
      await seed(ROOM.toUpperCase(), 1);
      expect(await popular()).not.toContain(ROOM.toUpperCase());
    });

    it('counts a lookalike spelling toward the real name (one person, one count)', async () => {
      // two people typed it plain, one typed it with a Cyrillic o: three people
      const text = `${MARK} Choir Room`;
      await room(text);
      await seed(text.toLowerCase(), 2);
      await seed(text.toLowerCase().replace('o', 'о'), 1);
      expect(await popular()).toContain(text);
    });

    it('reads circled digits as digits', async () => {
      await seed(`${MARK} top ❶⓿ songs`, 3);
      expect(await popular()).toContain(NUMBERED);
    });

    it('needs the name to be equal, not to contain the text', async () => {
      // a live piece is titled "<MARK> Afrobeats", a room "<MARK> Lagos Photographers"
      await seed(`${MARK} afro`, 5);
      await seed(`${MARK} lagos`, 5);
      const list = await popular();
      expect(list).not.toContain(`${MARK} afro`);
      expect(list).not.toContain(`${MARK} lagos`);
      expect(list.filter((t) => t.toLowerCase() === `${MARK} afro`)).toEqual(
        [],
      );
    });

    it('does not show a name nobody can see: pending content, a creator with no state', async () => {
      await piece('pending', `${MARK} Hidden Piece`, 'Music', 'pending');
      await prisma.userProfile.create({
        data: {
          wawuUserId: `${MARK}-c2`,
          accountType: 'creator',
          handle: `${MARK}nostate`,
          bio: 'bio',
        },
      });
      await seed(`${MARK} hidden piece`, 4);
      await seed(`${MARK}nostate`, 4);
      const list = await popular();
      expect(list).not.toContain(`${MARK} Hidden Piece`);
      expect(list).not.toContain(`${MARK}nostate`);
    });

    it('does not show a text with no public thing of that name: a person, a sentence', async () => {
      await seed(`${MARK} Chidinma Okafor`, 4);
      await seed(`${MARK} send money to my account`, 4);
      const list = await popular();
      expect(list).not.toContain(`${MARK} Chidinma Okafor`);
      expect(list).not.toContain(`${MARK} send money to my account`);
    });

    it('shows one name when a category, a room and a title are called the same', async () => {
      const t = `${MARK} Twin Name`;
      await piece('twin', t.toUpperCase(), t);
      await room(t.toLowerCase());
      await seed(t, 3);
      const shown = (await popular()).filter(
        (x) => x.toLowerCase() === t.toLowerCase(),
      );
      expect(shown).toEqual([t]); // the category, which comes first
    });
  });

  describe('what the character rule refuses, with a public thing of exactly that name', () => {
    beforeAll(async () => {
      for (const text of REFUSED_BY_CHARACTER_RULE) {
        await room(text);
        await seed(text, 4);
      }
    });

    it('lists none of the phone, email and link forms, and none of the invisible ones', async () => {
      const list = await popular();
      const shown = new Set(list.map((t) => t.normalize('NFKC').toLowerCase()));
      const leaked = REFUSED_BY_CHARACTER_RULE.filter((t) =>
        shown.has(t.normalize('NFKC').toLowerCase()),
      );
      expect(leaked).toEqual([]);
      expect(list.filter((t) => /\d{5}/.test(t))).toEqual([]);
    });

    it('is a rule on the name, not on how many people search: each room is a public result', async () => {
      // A visitor finds the room today, so only the character rule is left.
      for (const text of ['0801,234,5678', 'evil[.]example', 'evil.example']) {
        const res = data<{ communities: { name: string }[] }>(
          await http()
            .get('/api/hub/search')
            .query({ q: text, include: 'communities' }),
        );
        expect(res.communities.map((c) => c.name)).toContain(text);
      }
    });
  });

  describe('a flood of junk cannot push a real entry off', () => {
    it('keeps a real text with 3 searchers behind 45 junk texts with 4 searchers each', async () => {
      const real = `${MARK} Real Choir`;
      await room(real);
      await seed(real, 3);
      for (let i = 0; i < 45; i++)
        await seed(`${MARK} junk sentence number ${'x'.repeat(i + 1)}`, 4);
      expect(await popular()).toContain(real);
    });

    it('also holds when the junk has public results of its own that fail the rule', async () => {
      const real = `${MARK} Second Real Choir`;
      await room(real);
      await seed(real, 3);
      for (let i = 0; i < 45; i++) {
        const junk = `${MARK} 0801${String(i).padStart(2, '0')}234567`;
        await room(junk);
        await seed(junk, 5);
      }
      expect(await popular()).toContain(real);
    });
  });

  describe('the answer', () => {
    it('is at most eight entries, most people first', async () => {
      const names = Array.from({ length: 10 }, (_, i) => `${MARK} Rank ${i}`);
      // 'Rank i' holds a digit: at most four are allowed, one here
      for (const [i, name] of names.entries()) {
        await room(name);
        await seed(name, 3 + (9 - i)); // Rank 0 has the most people
      }
      const list = (await popular()).filter((t) =>
        t.startsWith(`${MARK} Rank`),
      );
      expect(list).toEqual(names.slice(0, 8));
    });

    it('counts only the last 30 days and only three or more people', async () => {
      const old = `${MARK} Old Choir`;
      const few = `${MARK} Few Choir`;
      await room(old);
      await room(few);
      await seed(old, 6, 31 * 86_400);
      await seed(few, 2);
      const list = await popular();
      expect(list).not.toContain(old);
      expect(list).not.toContain(few);
    });
  });

  describe('the 60 second cache', () => {
    afterEach(() => jest.restoreAllMocks());

    it('runs the ranking query once for two calls within 60 seconds', async () => {
      history.resetPopularCache();
      const spy = jest.spyOn(prisma, '$queryRaw');
      const first = await history.popular(new Date());
      const queries = spy.mock.calls.length;
      expect(queries).toBe(1);
      const second = await history.popular(new Date(Date.now() + 59_000));
      expect(spy.mock.calls.length).toBe(queries);
      expect(second).toEqual(first);
      // the route is the same call
      await http().get('/api/hub/search/popular');
      expect(spy.mock.calls.length).toBe(queries);
    });

    it('asks again after 60 seconds', async () => {
      history.resetPopularCache();
      const spy = jest.spyOn(prisma, '$queryRaw');
      await history.popular(new Date());
      await history.popular(new Date(Date.now() + 61_000));
      expect(spy.mock.calls.length).toBe(2);
    });

    it('runs the query once for calls that arrive together', async () => {
      history.resetPopularCache();
      const spy = jest.spyOn(prisma, '$queryRaw');
      await Promise.all(Array.from({ length: 6 }, () => history.popular()));
      expect(spy.mock.calls.length).toBe(1);
    });

    it('does not keep a failed answer', async () => {
      history.resetPopularCache();
      const spy = jest
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValueOnce(new Error('database down'));
      await expect(history.popular()).rejects.toThrow('database down');
      const again = await history.popular();
      expect(Array.isArray(again.items)).toBe(true);
      expect(spy.mock.calls.length).toBe(2);
    });
  });
});
