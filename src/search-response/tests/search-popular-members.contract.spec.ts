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
  POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT,
  POPULAR_COMMUNITY_MIN_MEMBERS_ENV,
  popularCommunityMinMembers,
} from '../search-history.config';
import {
  normaliseSearch,
  SearchHistoryService,
} from '../search-history.service';
import { joinMembers } from './popular-members';

/**
 * EXPLORE-06 (R-57, owner, 16 Oct 2026). GET /search/popular names a community
 * only once it has 10 or more members, however many people searched it. The
 * count is the one the room's row shows (`memberCount`: joined members, the
 * host not included). The other names (titles, handles, categories) are not
 * held to it, and the figure is a setting (popular_community_min_members).
 *
 * Rows made here carry MARK (letters only, so a name made from it holds no
 * digit) in their text, slug or ids, so the spec holds on a database other
 * suites have used.
 */
const MARK = 'exmembers';
const HOST = '00000000-0000-4000-8000-000000000003';
const MIN = POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT;

describe('GET /search/popular: a community needs enough members (EXPLORE-06)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let history: SearchHistoryService;
  const roomIds: string[] = [];
  let seedTag = 0;
  const saved = process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV];

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
  const room = async (name: string, members: number) => {
    const r = await prisma.community.create({
      data: { name, hostWawuId: HOST, kind: 'open', description: 'x' },
    });
    roomIds.push(r.id);
    await joinMembers(prisma, r.id, MARK, members);
    return r.id;
  };
  /** `people` accounts each searched `text`, stored as the Hub stores it. */
  const seed = (text: string, people = 25) => {
    const n = normaliseSearch(text);
    const tag = seedTag++;
    return prisma.searchHistory.createMany({
      data: Array.from({ length: people }, (_, i) => ({
        userWawuId: `${MARK}-u${i}-${tag}`,
        queryKey: n.queryKey,
        query: n.query,
        searchedAt: new Date(Date.now() - i * 1000),
      })),
    });
  };
  const memberCountOf = async (name: string): Promise<number | undefined> => {
    const res = await http()
      .get('/api/hub/search')
      .query({ q: name, tab: 'communities', include: 'communities' });
    const rows = data<{ communities: { name: string; memberCount: number }[] }>(
      res,
    ).communities;
    return rows.find((c) => c.name === name)?.memberCount;
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
    delete process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV];
    await cleanUp();
  }, 60000);

  afterEach(() => {
    delete process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV];
  });

  afterAll(async () => {
    if (saved === undefined)
      delete process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV];
    else process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV] = saved;
    await cleanUp();
    await app?.close();
  });

  it('the launch value is 10', () => {
    expect(MIN).toBe(10);
    expect(popularCommunityMinMembers({})).toBe(10);
  });

  it('a community with 9 members is not listed however many people searched it; at 10 it is', async () => {
    const name = `${MARK} Nine Then Ten`;
    const id = await room(name, MIN - 1);
    await seed(name.toLowerCase(), 60);
    expect(await popular()).not.toContain(name);
    expect(await memberCountOf(name)).toBe(MIN - 1);

    await joinMembers(prisma, id, `${MARK}x`, 1);
    expect(await memberCountOf(name)).toBe(MIN);
    expect(await popular()).toContain(name);
  });

  it('a person who asked to join and was not let in does not count as a member', async () => {
    const name = `${MARK} Waiting Room`;
    const id = await room(name, MIN - 1);
    await joinMembers(prisma, id, `${MARK}p`, 5, 'pending');
    await seed(name.toLowerCase());
    expect(await popular()).not.toContain(name);
    expect(await memberCountOf(name)).toBe(MIN - 1);
  });

  it('a room with no member, and one with many more than 10, behave the same way', async () => {
    const empty = `${MARK} Empty Room`;
    const big = `${MARK} Big Room`;
    await room(empty, 0);
    await room(big, MIN * 3);
    await seed(empty.toLowerCase());
    await seed(big.toLowerCase());
    const list = await popular();
    expect(list).not.toContain(empty);
    expect(list).toContain(big);
  });

  it('a content title, a creator handle and a category are not held to it', async () => {
    const title = `${MARK} Afrobeats Night`;
    const category = `${MARK} Highlife`;
    const handle = `${MARK}adaeze`;
    await prisma.contentPiece.create({
      data: {
        slug: `${MARK}-afro`,
        creatorWawuId: HOST,
        contentType: 'video',
        title,
        description: 'About',
        category,
        accessType: 'paid',
        price: 500,
        previewAssetUrl: 'https://img.example.com/p.png',
        status: 'live',
      },
    });
    await prisma.userProfile.create({
      data: {
        wawuUserId: `${MARK}-c1`,
        accountType: 'creator',
        handle,
        bio: 'bio',
      },
    });
    await prisma.creatorState.create({ data: { wawuUserId: `${MARK}-c1` } });
    for (const text of [title, category, handle])
      await seed(text.toLowerCase());
    expect(await popular()).toEqual(
      expect.arrayContaining([title, category, handle]),
    );
  });

  it('a room with 9 members and a content title of the same name: the name shows as the title', async () => {
    const name = `${MARK} Shared Name`;
    await room(name, MIN - 1);
    await prisma.contentPiece.create({
      data: {
        slug: `${MARK}-shared`,
        creatorWawuId: HOST,
        contentType: 'video',
        title: name,
        description: 'About',
        category: 'Music',
        accessType: 'paid',
        price: 500,
        previewAssetUrl: 'https://img.example.com/p.png',
        status: 'live',
      },
    });
    await seed(name.toLowerCase());
    expect(await popular()).toContain(name);
  });

  it('of two rooms with one name, the one with enough members is the name', async () => {
    const name = `${MARK} Twin Rooms`;
    await room(name, 2);
    await room(name, MIN + 2);
    await seed(name.toLowerCase());
    expect(await popular()).toContain(name);
  });

  describe('the setting', () => {
    it('reads a whole number of 1 or more; anything else keeps the ruled 10', () => {
      const read = (v: string | undefined) =>
        popularCommunityMinMembers({ [POPULAR_COMMUNITY_MIN_MEMBERS_ENV]: v });
      expect(read('25')).toBe(25);
      expect(read(' 5 ')).toBe(5);
      expect(read('1')).toBe(1);
      for (const bad of [
        undefined,
        '',
        '0',
        '-3',
        '2.5',
        'ten',
        '1e3',
        '99999999999999999999',
      ])
        expect(read(bad)).toBe(MIN);
    });

    it('changes who is listed without a change to the code', async () => {
      const name = `${MARK} Setting Room`;
      await room(name, 6);
      await seed(name.toLowerCase());
      expect(await popular()).not.toContain(name);

      process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV] = '5';
      expect(await popular()).toContain(name);

      process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV] = '7';
      expect(await popular()).not.toContain(name);

      process.env[POPULAR_COMMUNITY_MIN_MEMBERS_ENV] = '0';
      expect(await popular()).not.toContain(name);
    });
  });
});
