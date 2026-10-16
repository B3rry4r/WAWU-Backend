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
  POPULAR_MIN_PEOPLE,
  RECENT_SEARCHES_KEPT,
  RECENT_SEARCHES_SHOWN,
} from '../search-history.config';
import {
  normaliseSearch,
  SearchHistoryService,
} from '../search-history.service';

/**
 * EXPLORE-05: Recent (and Clear), People are searching, communities by name,
 * and the ticks on creator rows. Rows made here carry MARK in their text or
 * their ids, so the spec holds on a database other suites have used.
 */
const MARK = 'ex05';
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_PRO = '00000000-0000-4000-8000-000000000003';
const MOCK_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_ID = `http://localhost:${MOCK_ID_PORT}`;
const DAY = 86_400_000;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_ID}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Search: recent, popular, communities, ticks (EXPLORE-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plain: string;
  let basic: string;
  let pro: string;

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const record = (t: string, q: unknown) =>
    http().post('/api/hub/search/recent').set(auth(t)).send({ q });
  const suggestions = (t?: string, include?: string) => {
    const r = http()
      .get('/api/hub/search/suggestions')
      .query(include ? { include } : {});
    return t ? r.set(auth(t)) : r;
  };
  // EXPLORE-05 round 2: the app asks for its recent searches with include=recent.
  const recents = async (t: string) =>
    data<{ recentSearches: string[] }>(await suggestions(t, 'recent'))
      .recentSearches;
  const popular = async () => {
    app.get(SearchHistoryService).resetPopularCache(); // kept 60 s otherwise
    return data<{ items: string[] }>(
      await http().get('/api/hub/search/popular'),
    ).items;
  };

  async function startApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
        CommunityModule,
      ],
    }).compile();
    const a = moduleRef.createNestApplication();
    a.setGlobalPrefix('api/hub');
    a.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    a.useGlobalFilters(new AllExceptionsFilter());
    a.useGlobalInterceptors(new ResponseInterceptor());
    await a.init();
    return a;
  }

  async function cleanUp() {
    const fixtures = [`${MARK}-u`];
    await prisma.searchHistory.deleteMany({
      where: {
        OR: [
          { queryKey: { startsWith: MARK } },
          ...fixtures.map((p) => ({ userWawuId: { startsWith: p } })),
          { userWawuId: { in: [USER_PLAIN, USER_BASIC, USER_PRO] } },
        ],
      },
    });
    await prisma.community.deleteMany({ where: { name: { contains: MARK } } });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: USER_PLAIN, blockedWawuId: { startsWith: MARK } },
    });
    const profiles = await prisma.userProfile.findMany({
      where: { handle: { startsWith: `${MARK}tick` } },
      select: { wawuUserId: true },
    });
    const ids = profiles.map((p) => p.wawuUserId);
    await prisma.evgScore.deleteMany({ where: { creatorWawuId: { in: ids } } });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: ids } } });
  }

  beforeAll(async () => {
    [plain, basic, pro] = await Promise.all([
      login('user@test.wawu.dev'),
      login('creator-basic@test.wawu.dev'),
      login('creator-pro@test.wawu.dev'),
    ]);
    app = await startApp();
    prisma = app.get(PrismaService);
    await cleanUp();
  }, 40000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
  });

  describe('Recent searches', () => {
    it('needs a signed-in caller to save or clear', async () => {
      expect(
        (await http().post('/api/hub/search/recent').send({ q: 'x' })).status,
      ).toBe(401);
      expect((await http().delete('/api/hub/search/recent')).status).toBe(401);
      expect(await recents(plain)).not.toContain('nothing');
      expect(
        data<{ recentSearches: string[] }>(
          await suggestions(undefined, 'recent'),
        ).recentSearches,
      ).toEqual([]);
    });

    it('keeps one row per text, newest first, in the latest spelling', async () => {
      await record(plain, `${MARK} tax   Filing `);
      await record(plain, `${MARK} lagos events`);
      const res = await record(plain, `${MARK} TAX filing`);
      expect(res.status).toBe(201);
      expect(data<{ items: string[] }>(res).items.slice(0, 2)).toEqual([
        `${MARK} TAX filing`,
        `${MARK} lagos events`,
      ]);
      expect(
        await prisma.searchHistory.count({
          where: { userWawuId: USER_PLAIN, queryKey: { startsWith: MARK } },
        }),
      ).toBe(2);
      // Somebody else never sees it.
      expect(await recents(basic)).not.toContain(`${MARK} TAX filing`);
    });

    it('survives a restart of the server', async () => {
      const before = await recents(plain);
      expect(before.length).toBeGreaterThan(0);
      await app.close();
      app = await startApp();
      prisma = app.get(PrismaService);
      expect(await recents(plain)).toEqual(before);
    });

    it('keeps the newest twenty and shows the newest ten', async () => {
      for (let i = 0; i < RECENT_SEARCHES_KEPT + 5; i++) {
        await record(basic, `${MARK} q${String(i).padStart(2, '0')}`);
      }
      expect(
        await prisma.searchHistory.count({ where: { userWawuId: USER_BASIC } }),
      ).toBe(RECENT_SEARCHES_KEPT);
      const shown = await recents(basic);
      expect(shown).toHaveLength(RECENT_SEARCHES_SHOWN);
      expect(shown[0]).toBe(`${MARK} q${RECENT_SEARCHES_KEPT + 4}`);
      // The first five went, the oldest kept is q05.
      expect(
        await prisma.searchHistory.findFirst({
          where: { userWawuId: USER_BASIC, queryKey: `${MARK} q04` },
        }),
      ).toBeNull();
      expect(
        await prisma.searchHistory.findFirst({
          where: { userWawuId: USER_BASIC, queryKey: `${MARK} q05` },
        }),
      ).not.toBeNull();
    });

    it("Clear removes the caller's searches and nobody else's", async () => {
      await record(pro, `${MARK} keep me`);
      const res = await http()
        .delete('/api/hub/search/recent')
        .set(auth(basic));
      expect(res.status).toBe(200);
      expect(data<{ cleared: number }>(res).cleared).toBe(RECENT_SEARCHES_KEPT);
      expect(await recents(basic)).toEqual([]);
      expect(await recents(pro)).toContain(`${MARK} keep me`);
      // Clearing again is not an error.
      const again = await http()
        .delete('/api/hub/search/recent')
        .set(auth(basic));
      expect(data<{ cleared: number }>(again).cleared).toBe(0);
    });

    it('answers odd inputs with 400, never 500', async () => {
      const bad: unknown[] = [
        '',
        '   ',
        'a\u0000b',
        'x'.repeat(5000),
        123,
        null,
        ['a'],
        { a: 1 },
      ];
      for (const q of bad) {
        const res = await record(plain, q);
        expect([q, res.status]).toEqual([q, 400]);
      }
      const noBody = await http()
        .post('/api/hub/search/recent')
        .set(auth(plain));
      expect(noBody.status).toBe(400);
      const extra = await http()
        .post('/api/hub/search/recent')
        .set(auth(plain))
        .send({ q: 'fine', other: 1 });
      expect(extra.status).toBe(400);
      const arr = await http()
        .post('/api/hub/search/recent')
        .set(auth(plain))
        .send([{ q: 'fine' }]);
      expect(arr.status).toBe(400);
    });

    it('normalises text', () => {
      expect(normaliseSearch('  Tax \t Filing ')).toEqual({
        query: 'Tax Filing',
        queryKey: 'tax filing',
      });
    });
  });

  describe('People are searching', () => {
    // Round 3: a popular search is the name of a public thing, so the texts
    // below are each the exact name of a public room.
    beforeAll(async () => {
      for (const name of [`${MARK} Alpha`, `${MARK} Gamma`])
        await prisma.community.create({
          data: {
            name,
            hostWawuId: USER_BASIC,
            kind: 'open',
            description: 'x',
          },
        });
    });

    const seed = (key: string, query: string, people: number, ageDays = 0) =>
      prisma.searchHistory.createMany({
        data: Array.from({ length: people }, (_, i) => ({
          userWawuId: `${MARK}-u${i}-${key}`,
          queryKey: key,
          query,
          searchedAt: new Date(Date.now() - ageDays * DAY - i * 1000),
        })),
      });

    it('lists what enough different people searched, most people first, and nothing else', async () => {
      await seed(`${MARK} alpha`, `${MARK} Alpha`, 40);
      await seed(`${MARK} beta`, `${MARK} Beta`, POPULAR_MIN_PEOPLE - 1);
      await seed(`${MARK} old`, `${MARK} Old`, 45, 40);
      await seed(`${MARK}@mail.example`, `${MARK}@mail.example`, 41);
      await seed(`${MARK} 08031234567`, `${MARK} 08031234567`, 42);
      const list = await popular();
      expect(list[0]).toBe(`${MARK} Alpha`);
      expect(list).not.toContain(`${MARK} Beta`); // too few people
      expect(list).not.toContain(`${MARK} Old`); // too long ago
      expect(list.filter((t) => t.includes('@'))).toEqual([]);
      expect(list.filter((t) => t.includes('0803'))).toEqual([]);
      expect(list.length).toBeLessThanOrEqual(8);
      // Public: no token needed, and a bad token is not a 401.
      const res = await http()
        .get('/api/hub/search/popular')
        .set(auth('not-a-token'));
      expect(res.status).toBe(200);
    });

    it("counts people, not searches, and shows the thing's own name", async () => {
      await prisma.searchHistory.deleteMany({
        where: { queryKey: `${MARK} gamma` },
      });
      // One person searching it again and again is still one person.
      for (let i = 0; i < 5; i++) await record(plain, `${MARK} Gamma`);
      expect(await popular()).not.toContain(`${MARK} Gamma`);
      await record(basic, `${MARK} gamma`);
      expect(await popular()).not.toContain(`${MARK} gamma`);
      await record(pro, `${MARK} GAMMA`);
      const list = await popular();
      expect(list).toContain(`${MARK} Gamma`); // the room's name
      expect(list).not.toContain(`${MARK} GAMMA`); // not the newest spelling
      expect(list).not.toContain(`${MARK} gamma`);
    });

    it('drops a search when one of the people clears theirs', async () => {
      expect(await popular()).toContain(`${MARK} Gamma`);
      await http().delete('/api/hub/search/recent').set(auth(pro));
      expect(await popular()).not.toContain(`${MARK} Gamma`);
      expect(await popular()).not.toContain(`${MARK} gamma`);
    });

    it('leaves GET /search/suggestions popularSearches as it was for the web', async () => {
      const res = data<{ popularSearches: string[] }>(await suggestions());
      expect(Array.isArray(res.popularSearches)).toBe(true);
      expect(res.popularSearches).not.toContain(`${MARK} Alpha`);
    });
  });

  describe('Communities by name', () => {
    const HOST = `${MARK}-host-1`;
    const OTHER_HOST = `${MARK}-host-2`;
    let open: string;
    let priv: string;
    let hostedByBlocked: string;

    beforeAll(async () => {
      const mk = (
        name: string,
        kind: 'open' | 'private',
        host: string,
        description = 'About',
      ) =>
        prisma.community.create({
          data: {
            name,
            kind,
            hostWawuId: host,
            description,
            imageUrl:
              kind === 'private' ? 'https://img.example.com/c.png' : null,
          },
        });
      const a = await mk(`${MARK} Pricing clinic`, 'private', HOST);
      const b = await mk(`Lagos ${MARK} pricing hub`, 'open', HOST);
      const c = await mk(`${MARK} Pricing for blocked`, 'open', OTHER_HOST);
      await mk(
        `${MARK} Unrelated room`,
        'open',
        HOST,
        'pricing is in this description only',
      );
      priv = a.id;
      open = b.id;
      hostedByBlocked = c.id;
      // The clinic has 2 joined members and 1 waiting; the hub has 5 joined.
      await prisma.communityMembership.createMany({
        data: [
          {
            userWawuId: `${MARK}-m1`,
            communityId: priv,
            status: 'joined',
            joinedAt: new Date(),
          },
          {
            userWawuId: `${MARK}-m2`,
            communityId: priv,
            status: 'joined',
            joinedAt: new Date(),
          },
          { userWawuId: `${MARK}-m3`, communityId: priv, status: 'pending' },
          ...[1, 2, 3, 4, 5].map((n) => ({
            userWawuId: `${MARK}-n${n}`,
            communityId: open,
            status: 'joined' as const,
            joinedAt: new Date(),
          })),
        ],
      });
      await prisma.communityMessage.createMany({
        data: [
          { communityId: priv, senderWawuId: `${MARK}-m1`, text: 'today' },
          { communityId: priv, senderWawuId: `${MARK}-m2`, text: 'today too' },
          {
            communityId: priv,
            senderWawuId: `${MARK}-m1`,
            text: 'last week',
            sentAt: new Date(Date.now() - 7 * DAY),
          },
        ],
      });
    });

    type Room = {
      id: string;
      name: string;
      kind: string;
      memberCount: number;
      messagesToday: number;
      hostWawuId: string;
    };
    const search = async (q: string, tab?: string, token?: string) => {
      // The app asks for rooms with include=communities (round 2).
      const r = http()
        .get('/api/hub/search')
        .query({ q, include: 'communities', ...(tab ? { tab } : {}) });
      return data<{
        communities: Room[];
        content: unknown[];
        creators: unknown[];
      }>(await (token ? r.set(auth(token)) : r));
    };

    it('finds communities by name on tab=all and tab=communities, any case', async () => {
      const all = await search(`${MARK} PRICING`);
      const names = all.communities.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          `${MARK} Pricing clinic`,
          `${MARK} Pricing for blocked`,
        ]),
      );
      const tab = await search(`${MARK} pricing`, 'communities');
      expect(tab.communities.map((c) => c.id)).toEqual(
        expect.arrayContaining([priv]),
      );
      expect(tab.content).toEqual([]);
      expect(tab.creators).toEqual([]);
      // Matching is by name: the room with "pricing" only in its description is not a result.
      const byDescription = await search(
        'this description only',
        'communities',
      );
      expect(byDescription.communities).toEqual([]);
    });

    it('is empty on the other tabs and for a name nobody has', async () => {
      expect((await search(`${MARK} pricing`, 'content')).communities).toEqual(
        [],
      );
      expect((await search(`${MARK} pricing`, 'creators')).communities).toEqual(
        [],
      );
      expect((await search(`${MARK} pricing`, 'schools')).communities).toEqual(
        [],
      );
      expect(
        (await search(`${MARK} zzzz nobody`, 'communities')).communities,
      ).toEqual([]);
    });

    it('ranks a name that starts with the search first, then the bigger room', async () => {
      const list = (await search(`${MARK} pricing`, 'communities')).communities;
      const mine = list.filter((c) => c.name.includes(MARK));
      // Two names start with the search (the one with members first); the hub, which has the most members, does not.
      expect(mine.map((c) => c.name)).toEqual([
        `${MARK} Pricing clinic`,
        `${MARK} Pricing for blocked`,
        `Lagos ${MARK} pricing hub`,
      ]);
      const wide = (await search('pricing', 'communities')).communities.filter(
        (c) => c.name.includes(MARK),
      );
      // Neither starts with "pricing": the hub (5 joined) beats the clinic (2).
      expect(wide.map((c) => c.id).slice(0, 2)).toEqual([open, priv]);
    });

    it("counts members and today's messages like GET /communities/:id", async () => {
      const room = (await search(`${MARK} pricing clinic`, 'communities'))
        .communities[0];
      expect(room.kind).toBe('private');
      expect(room.memberCount).toBe(2); // two joined, one waiting is not counted
      expect(room.messagesToday).toBe(2);
      const direct = data<Room>(
        await http().get(`/api/hub/communities/${priv}`).set(auth(plain)),
      );
      expect({ m: room.memberCount, t: room.messagesToday }).toEqual({
        m: direct.memberCount,
        t: direct.messagesToday,
      });
      const hub = (await search(`${MARK} pricing hub`, 'communities'))
        .communities[0];
      expect(hub.memberCount).toBe(5);
    });

    it('hides a room hosted by somebody the caller blocked', async () => {
      await prisma.blockedAccount.create({
        data: { userWawuId: USER_PLAIN, blockedWawuId: OTHER_HOST },
      });
      const asCaller = await search(`${MARK} pricing`, 'communities', plain);
      expect(asCaller.communities.map((c) => c.id)).not.toContain(
        hostedByBlocked,
      );
      const asOther = await search(`${MARK} pricing`, 'communities', basic);
      expect(asOther.communities.map((c) => c.id)).toContain(hostedByBlocked);
    });

    it('answers odd inputs with 400, never 500', async () => {
      for (const q of ['%00', 'a%00b']) {
        const res = await http().get(
          `/api/hub/search?tab=communities&include=communities&q=${q}`,
        );
        expect(res.status).toBe(400);
      }
      const wild = await http()
        .get('/api/hub/search')
        .query({ q: '%_\\', tab: 'communities', include: 'communities' });
      expect(wild.status).toBe(200);
    });
  });

  describe('Ticks on creator rows', () => {
    const profile = (id: string, handle: string, extra: object) =>
      prisma.userProfile.create({
        data: {
          wawuUserId: id,
          accountType: 'creator',
          handle,
          bio: `${MARK} bio`,
          ...extra,
        },
      });
    const future = new Date(Date.now() + 90 * DAY);
    const past = new Date(Date.now() - 2 * DAY);
    const long = new Date(Date.now() - 400 * DAY);
    const ids = {
      purple: `${MARK}-t-purple`,
      lapsed: `${MARK}-t-lapsed`,
      both: `${MARK}-t-both`,
      none: `${MARK}-t-none`,
    };

    beforeAll(async () => {
      await profile(ids.purple, `${MARK}tick-purple`, {
        creatorVerifiedAt: long,
        creatorVerifiedUntil: future,
      });
      await profile(ids.lapsed, `${MARK}tick-lapsed`, {
        creatorVerifiedAt: long,
        creatorVerifiedUntil: past,
      });
      await profile(ids.both, `${MARK}tick-both`, {
        creatorVerifiedAt: long,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: long,
        professionalVerifiedUntil: future,
      });
      await profile(ids.none, `${MARK}tick-none`, {});
      await prisma.creatorState.createMany({
        data: Object.values(ids).map((wawuUserId) => ({ wawuUserId })),
      });
      // The top of the ranking, so "Creators to know" is these four.
      await prisma.evgScore.createMany({
        data: Object.values(ids).map((creatorWawuId, i) => ({
          creatorWawuId,
          score: 2_000_000_000 - i,
        })),
      });
    });

    type Row = {
      wawuUserId: string;
      verification: {
        creator: { verified: boolean; expiresAt: string | null };
        professional: { verified: boolean; expiresAt: string | null };
      };
    };
    const ticks = (rows: Row[]) =>
      Object.fromEntries(
        rows
          .filter((r) => Object.values(ids).includes(r.wawuUserId))
          .map((r) => [
            r.wawuUserId,
            [
              r.verification.creator.verified,
              r.verification.professional.verified,
            ],
          ]),
      );
    const expected = {
      [ids.purple]: [true, false],
      [ids.lapsed]: [false, false], // a lapsed tick is not drawn
      [ids.both]: [true, true], // both ticks, neither hides the other
      [ids.none]: [false, false],
    };

    it('marks ticked creators in search results', async () => {
      for (const tab of ['all', 'creators']) {
        const res = data<{ creators: Row[] }>(
          await http()
            .get('/api/hub/search')
            .query({ q: `${MARK}tick`, tab }),
        );
        expect(ticks(res.creators)).toEqual(expected);
      }
    });

    it('marks ticked creators in Creators to know', async () => {
      const res = data<{ suggestedCreators: Row[] }>(await suggestions());
      expect(ticks(res.suggestedCreators)).toEqual(expected);
    });

    it('carries the date a tick runs out, and null for a perpetual one', async () => {
      const res = data<{ creators: Row[] }>(
        await http()
          .get('/api/hub/search')
          .query({ q: `${MARK}tick-both` }),
      );
      const row = res.creators.find((r) => r.wawuUserId === ids.both);
      expect(row?.verification.creator.expiresAt).toBeNull();
      expect(row?.verification.professional.expiresAt).toBe(
        future.toISOString(),
      );
    });
  });
});
