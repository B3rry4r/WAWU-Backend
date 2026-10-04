// SETTINGS-04: a block hides people from each other on every read surface.
//
// Before this change a block stopped new messages, tips, follows and comments
// and nothing else: the blocked person still sat in search, on Explore, in the
// feed, on a profile and in every room. Each test below is one surface and
// follows the same three steps, so a surface that stops honouring blocks fails
// by name:
//
//   1. before any block, the person IS on that surface (so "absent" proves
//      something and is not an empty fixture);
//   2. after the block, they are not, in the direction that was blocked;
//   3. after the unblock, they are back (the block was the only cause).
//
// The viewer is the seeded plain user (Adaeze) and the person hidden is the
// seeded Pro creator (Zainab), who owns two live pieces, an EVG score, a
// profile and, from this spec's fixtures, a room, an event and a listing.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account.module';
import { BlockedAccountService } from '../blocked-account.service';
import { SearchResponseModule } from '../../search-response/search-response.module';
import { CreatorDiscoveryModule } from '../../creator-discovery/creator-discovery.module';
import { UserProfileModule } from '../../user-profile/user-profile.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { CommentModule } from '../../comment/comment.module';
import { CommunityModule } from '../../community/community.module';
import { CommunityMessageModule } from '../../community-message/community-message.module';
import { ProfessionalModule } from '../../professional/professional.module';
import { EventModule } from '../../event/event.module';
import { EvgScoreModule } from '../../evg-score/evg-score.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // Adaeze, the viewer
const USER_BASIC = '00000000-0000-4000-8000-000000000002'; // Chidi
const USER_PRO = '00000000-0000-4000-8000-000000000003'; // Zainab, the one hidden

const CAC_COURSE = '10000000-0000-4000-8000-000000000001'; // by PRO, bought by PLAIN
const INVOICE_PACK = '10000000-0000-4000-8000-000000000003'; // by PRO, NOT bought
const MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002'; // by BASIC
const FOUNDERS_ROOM = '20000000-0000-4000-8000-000000000001'; // hosted by PRO, PLAIN is in it

// Fixtures this spec owns, under ids nothing else uses, deleted in afterAll.
const ROOM_BY_PRO = '5a040000-0000-4000-8000-000000000001'; // PLAIN is not in it
const ROOM_BY_BASIC = '5a040000-0000-4000-8000-000000000002'; // PLAIN and PRO are in it
const EVENT_BY_PRO = '5a040000-0000-4000-8000-000000000003';
const LISTING_BY_PRO = '5a040000-0000-4000-8000-000000000004';
const COMMENT_BY_PRO_ON_BASIC = '5a040000-0000-4000-8000-000000000005';
const COMMENT_BY_BASIC_ON_BASIC = '5a040000-0000-4000-8000-000000000006';
const MESSAGE_BY_PRO = '5a040000-0000-4000-8000-000000000007';
const MESSAGE_BY_BASIC = '5a040000-0000-4000-8000-000000000008';
const MEMBERSHIPS = [
  '5a040000-0000-4000-8000-000000000009',
  '5a040000-0000-4000-8000-00000000000a',
  '5a040000-0000-4000-8000-00000000000b',
];

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Blocking hides people (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let blocks: BlockedAccountService;
  let mock: ChildProcess | undefined;
  let ownedMock = false;
  let plain: string;
  let pro: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (url: string, token?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return token ? r.set(as(token)) : r;
  };
  const clearBlocks = () =>
    prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: [USER_PLAIN, USER_BASIC, USER_PRO] } },
    });
  const plainBlocksPro = () =>
    prisma.blockedAccount.create({
      data: { userWawuId: USER_PLAIN, blockedWawuId: USER_PRO },
    });
  const proBlocksPlain = () =>
    prisma.blockedAccount.create({
      data: { userWawuId: USER_PRO, blockedWawuId: USER_PLAIN },
    });

  interface Envelope<T> {
    message: string;
    data: T;
    pagination: { total: number };
  }
  const envelope = <T>(res: request.Response) => res.body as Envelope<T>;
  const ids = (res: request.Response, key = 'id') =>
    envelope<Array<Record<string, unknown>>>(res).data.map((x) => x[key]);
  const total = (res: request.Response) =>
    envelope<unknown>(res).pagination.total;
  const message = (res: request.Response) => envelope<unknown>(res).message;
  /** Ids in one array of a /search answer. */
  const found = async (
    url: string,
    token: string | undefined,
    part: 'content' | 'creators',
  ): Promise<string[]> => {
    const res = await get(url, token).expect(200);
    const data =
      envelope<Record<string, Array<Record<string, string>>>>(res).data;
    return data[part].map((x) => (part === 'content' ? x.id : x.wawuUserId));
  };
  const suggestions = async (token: string) =>
    envelope<{
      suggestedCreators: Array<{ wawuUserId: string }>;
      popularSearches: string[];
    }>(await get('/search/suggestions', token).expect(200)).data;
  const closestIds = async (url: string, token: string) =>
    envelope<{ items: Array<{ id: string }> }>(
      await get(url, token).expect(200),
    ).data.items.map((x) => x.id);

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not come up');
      }
    }
    plain = await login('user@test.wawu.dev');
    pro = await login('creator-pro@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        SearchResponseModule,
        CreatorDiscoveryModule,
        UserProfileModule,
        ContentPieceModule,
        CommentModule,
        CommunityModule,
        CommunityMessageModule,
        ProfessionalModule,
        EventModule,
        EvgScoreModule,
        FollowRelationshipModule,
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
    blocks = moduleRef.get(BlockedAccountService);

    await clearBlocks();
    await prisma.community.createMany({
      data: [
        {
          id: ROOM_BY_PRO,
          name: 'S04 room hosted by Zainab',
          description: 'fixture',
          hostWawuId: USER_PRO,
          kind: 'open',
        },
        {
          id: ROOM_BY_BASIC,
          name: 'S04 room hosted by Chidi',
          description: 'fixture',
          hostWawuId: USER_BASIC,
          kind: 'open',
        },
      ],
    });
    await prisma.communityMembership.createMany({
      data: [
        {
          id: MEMBERSHIPS[0],
          userWawuId: USER_PLAIN,
          communityId: ROOM_BY_BASIC,
          status: 'joined',
          joinedAt: new Date(Date.now() - 3_600_000),
        },
        {
          id: MEMBERSHIPS[1],
          userWawuId: USER_PRO,
          communityId: ROOM_BY_BASIC,
          status: 'joined',
          joinedAt: new Date(Date.now() - 3_600_000),
        },
        {
          id: MEMBERSHIPS[2],
          userWawuId: USER_BASIC,
          communityId: ROOM_BY_BASIC,
          status: 'joined',
          joinedAt: new Date(Date.now() - 3_600_000),
        },
      ],
    });
    await prisma.communityMessage.createMany({
      data: [
        {
          id: MESSAGE_BY_PRO,
          communityId: ROOM_BY_BASIC,
          senderWawuId: USER_PRO,
          text: 'S04 message from Zainab',
          sentAt: new Date(),
        },
        {
          id: MESSAGE_BY_BASIC,
          communityId: ROOM_BY_BASIC,
          senderWawuId: USER_BASIC,
          text: 'S04 message from Chidi',
          sentAt: new Date(Date.now() - 60_000),
        },
      ],
    });
    await prisma.comment.createMany({
      data: [
        {
          id: COMMENT_BY_PRO_ON_BASIC,
          contentId: MAKEUP_VIDEO,
          authorWawuId: USER_PRO,
          text: 'S04 comment from Zainab',
        },
        {
          id: COMMENT_BY_BASIC_ON_BASIC,
          contentId: MAKEUP_VIDEO,
          authorWawuId: USER_BASIC,
          text: 'S04 comment from Chidi',
        },
      ],
    });
    const in30 = new Date(Date.now() + 30 * 86_400_000);
    await prisma.event.create({
      data: {
        id: EVENT_BY_PRO,
        hostWawuId: USER_PRO,
        name: 'S04 event hosted by Zainab',
        description: 'fixture',
        hostOrg: 'Zainab Pro',
        format: 'online',
        type: 'webinar',
        startsAt: in30,
        location: 'Online',
        status: 'published',
      },
    });
    await prisma.professionalProfile.create({
      data: {
        id: LISTING_BY_PRO,
        wawuUserId: USER_PRO,
        category: 'Accounting',
        headline: 'S04 listing',
        about: 'fixture',
        credentialKind: 'qualification',
        status: 'approved',
        listed: true,
        reviewedAt: new Date(),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await clearBlocks();
    await prisma.professionalProfile.deleteMany({
      where: { id: LISTING_BY_PRO },
    });
    await prisma.event.deleteMany({ where: { id: EVENT_BY_PRO } });
    await prisma.comment.deleteMany({
      where: {
        id: { in: [COMMENT_BY_PRO_ON_BASIC, COMMENT_BY_BASIC_ON_BASIC] },
      },
    });
    await prisma.communityMessage.deleteMany({
      where: { id: { in: [MESSAGE_BY_PRO, MESSAGE_BY_BASIC] } },
    });
    await prisma.communityMembership.deleteMany({
      where: { id: { in: MEMBERSHIPS } },
    });
    await prisma.community.deleteMany({
      where: { id: { in: [ROOM_BY_PRO, ROOM_BY_BASIC] } },
    });
    await app.close();
    if (ownedMock && mock) mock.kill();
  });

  beforeEach(clearBlocks);

  // ---- search ------------------------------------------------------------

  it('a user who blocked someone no longer finds their content in search, and finds it again after unblocking', async () => {
    const q = '/search?q=CAC&tab=content';
    expect(await found(q, plain, 'content')).toContain(CAC_COURSE);
    await plainBlocksPro();
    expect(await found(q, plain, 'content')).not.toContain(CAC_COURSE);
    await clearBlocks();
    expect(await found(q, plain, 'content')).toContain(CAC_COURSE);
  });

  it('a user who blocked someone no longer finds them among creators in search', async () => {
    const q = '/search?q=zainab&tab=creators';
    const has = async () =>
      (await found(q, plain, 'creators')).includes(USER_PRO);
    expect(await has()).toBe(true);
    await plainBlocksPro();
    expect(await has()).toBe(false);
    await clearBlocks();
    expect(await has()).toBe(true);
  });

  it('a user who was blocked by someone no longer finds that person in search either', async () => {
    await proBlocksPlain();
    expect(await found('/search?q=zainab', plain, 'creators')).not.toContain(
      USER_PRO,
    );
  });

  it('a user who blocked someone never sees them as a suggested creator or in popular searches', async () => {
    const before = await suggestions(plain);
    expect(before.suggestedCreators.map((c) => c.wawuUserId)).toContain(
      USER_PRO,
    );
    expect(before.popularSearches).toContain('SEEDED: CAC in 7 days');
    await plainBlocksPro();
    const after = await suggestions(plain);
    expect(after.suggestedCreators.map((c) => c.wawuUserId)).not.toContain(
      USER_PRO,
    );
    expect(after.popularSearches).not.toContain('SEEDED: CAC in 7 days');
  });

  it('a user who blocked someone does not get their work as a closest match', async () => {
    const q = '/search/closest?q=invoice%20template';
    expect(await closestIds(q, plain)).toContain(INVOICE_PACK);
    await plainBlocksPro();
    expect(await closestIds(q, plain)).not.toContain(INVOICE_PACK);
  });

  it('a signed-out reader still finds everyone, because a block is between two accounts', async () => {
    await plainBlocksPro();
    expect(await found('/search?q=zainab', undefined, 'creators')).toContain(
      USER_PRO,
    );
  });

  // ---- creators (Explore) ------------------------------------------------

  it('a user who blocked a creator does not see them on Explore, and the total drops by one', async () => {
    const q = '/creators?perPage=50';
    const before = await get(q, plain).expect(200);
    expect(ids(before, 'wawuId')).toContain(USER_PRO);
    await plainBlocksPro();
    const after = await get(q, plain).expect(200);
    expect(ids(after, 'wawuId')).not.toContain(USER_PRO);
    expect(total(after)).toBe(total(before) - 1);
    await clearBlocks();
    expect(ids(await get(q, plain).expect(200), 'wawuId')).toContain(USER_PRO);
  });

  // ---- profile -----------------------------------------------------------

  it('a user who blocked a creator gets "not found" for their profile, by id and by handle, and the profile returns after unblocking', async () => {
    await get(`/users/${USER_PRO}/public-profile`, plain).expect(200);
    await plainBlocksPro();
    const byId = await get(`/users/${USER_PRO}/public-profile`, plain).expect(
      404,
    );
    const byHandle = await get(
      '/users/zainab-pro/public-profile',
      plain,
    ).expect(404);
    const unknown = await get(
      '/users/nobody-at-all/public-profile',
      plain,
    ).expect(404);
    // The answer is the one an unknown handle gets, so it cannot be used to
    // tell a block from a missing person.
    expect(message(byId)).toBe(message(unknown));
    expect(message(byHandle)).toBe(message(unknown));
    await clearBlocks();
    await get(`/users/${USER_PRO}/public-profile`, plain).expect(200);
  });

  it('a user who was blocked by a creator gets "not found" for that creator\'s profile and shelf', async () => {
    await proBlocksPlain();
    await get(`/users/${USER_PRO}/public-profile`, plain).expect(404);
    await get(`/users/${USER_PRO}/content`, plain).expect(404);
  });

  it('a user who blocked a creator cannot open their shelf, and can again after unblocking', async () => {
    const res = await get(`/users/${USER_PRO}/content`, plain).expect(200);
    expect(ids(res)).toContain(INVOICE_PACK);
    await plainBlocksPro();
    await get(`/users/${USER_PRO}/content`, plain).expect(404);
    await clearBlocks();
    await get(`/users/${USER_PRO}/content`, plain).expect(200);
  });

  it('a user who blocked a creator cannot read their EVG score', async () => {
    await get(`/creators/${USER_PRO}/evg`, plain).expect(200);
    await plainBlocksPro();
    await get(`/creators/${USER_PRO}/evg`, plain).expect(404);
    await clearBlocks();
    await get(`/creators/${USER_PRO}/evg`, plain).expect(200);
  });

  it('a signed-out reader still opens every public profile', async () => {
    await plainBlocksPro();
    await get(`/users/public/${USER_PRO}`).expect(200);
  });

  // ---- feed and content --------------------------------------------------

  it('a user who blocked a creator does not see their work in the feed, ranked or newest first, and the total drops', async () => {
    for (const sort of ['trending', 'recent']) {
      const q = `/content?scope=feed&sort=${sort}&perPage=50`;
      const before = await get(q, plain).expect(200);
      expect(ids(before)).toContain(INVOICE_PACK);
      await plainBlocksPro();
      const after = await get(q, plain).expect(200);
      expect(ids(after)).not.toContain(INVOICE_PACK);
      expect(ids(after)).not.toContain(CAC_COURSE);
      expect(ids(after)).toContain(MAKEUP_VIDEO);
      expect(total(after)).toBe(total(before) - 2);
      await clearBlocks();
      expect(ids(await get(q, plain).expect(200))).toContain(INVOICE_PACK);
    }
  });

  it('a user who blocked a creator cannot open, save or unlock a piece they have not bought, and can again after unblocking', async () => {
    await get(`/content/${INVOICE_PACK}`, plain).expect(200);
    await plainBlocksPro();
    await get(`/content/${INVOICE_PACK}`, plain).expect(404);
    await request(app.getHttpServer())
      .post(`/content/${INVOICE_PACK}/save`)
      .set(as(plain))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/content/${INVOICE_PACK}/unlock`)
      .set(as(plain))
      .expect(404);
    await clearBlocks();
    await get(`/content/${INVOICE_PACK}`, plain).expect(200);
  });

  it('a user who bought a piece keeps it after blocking its creator, because a block never takes away what was paid for', async () => {
    await plainBlocksPro();
    const res = await get(`/content/${CAC_COURSE}`, plain).expect(200);
    expect(
      envelope<{ fullAssetLocked: boolean }>(res).data.fullAssetLocked,
    ).toBe(false);
  });

  it("a creator who was blocked cannot open their blocker's piece either", async () => {
    await prisma.blockedAccount.create({
      data: { userWawuId: USER_BASIC, blockedWawuId: USER_PRO },
    });
    await get(`/content/${MAKEUP_VIDEO}`, pro).expect(404);
  });

  // ---- comments ----------------------------------------------------------

  it('a user who blocked a commenter no longer sees their comments under a piece, and the count drops', async () => {
    const q = `/content/${MAKEUP_VIDEO}/comments?perPage=50`;
    const before = await get(q, plain).expect(200);
    expect(ids(before)).toEqual(
      expect.arrayContaining([
        COMMENT_BY_PRO_ON_BASIC,
        COMMENT_BY_BASIC_ON_BASIC,
      ]),
    );
    await plainBlocksPro();
    const after = await get(q, plain).expect(200);
    expect(ids(after)).not.toContain(COMMENT_BY_PRO_ON_BASIC);
    expect(ids(after)).toContain(COMMENT_BY_BASIC_ON_BASIC);
    expect(total(after)).toBe(total(before) - 1);
    await clearBlocks();
    expect(ids(await get(q, plain).expect(200))).toContain(
      COMMENT_BY_PRO_ON_BASIC,
    );
  });

  it('a user who was blocked by a commenter no longer sees their comments either', async () => {
    await proBlocksPlain();
    const res = await get(
      `/content/${MAKEUP_VIDEO}/comments?perPage=50`,
      plain,
    ).expect(200);
    expect(ids(res)).not.toContain(COMMENT_BY_PRO_ON_BASIC);
  });

  it("a user who blocked a creator cannot read the comments under that creator's piece", async () => {
    await get(`/content/${INVOICE_PACK}/comments`, plain).expect(200);
    await plainBlocksPro();
    await get(`/content/${INVOICE_PACK}/comments`, plain).expect(404);
  });

  // ---- rooms -------------------------------------------------------------

  it('a user who blocked a host does not see their rooms in the list, and the total drops', async () => {
    const q = '/communities?perPage=100';
    const before = await get(q, plain).expect(200);
    expect(ids(before)).toEqual(
      expect.arrayContaining([ROOM_BY_PRO, FOUNDERS_ROOM]),
    );
    await plainBlocksPro();
    const after = await get(q, plain).expect(200);
    expect(ids(after)).not.toContain(ROOM_BY_PRO);
    expect(ids(after)).not.toContain(FOUNDERS_ROOM);
    expect(ids(after)).toContain(ROOM_BY_BASIC);
    expect(total(after)).toBe(total(before) - 2);
    await clearBlocks();
    expect(ids(await get(q, plain).expect(200))).toContain(ROOM_BY_PRO);
  });

  it('a user who blocked a host cannot open a room they are not in, but keeps the room they already joined', async () => {
    await get(`/communities/${ROOM_BY_PRO}`, plain).expect(200);
    await plainBlocksPro();
    await get(`/communities/${ROOM_BY_PRO}`, plain).expect(404);
    await get(`/communities/${FOUNDERS_ROOM}`, plain).expect(200);
  });

  it('a user who blocked a member does not see what that member wrote in a shared room', async () => {
    const q = `/communities/${ROOM_BY_BASIC}/messages?perPage=50`;
    const before = await get(q, plain).expect(200);
    expect(ids(before)).toEqual(
      expect.arrayContaining([MESSAGE_BY_PRO, MESSAGE_BY_BASIC]),
    );
    await plainBlocksPro();
    const after = await get(q, plain).expect(200);
    expect(ids(after)).not.toContain(MESSAGE_BY_PRO);
    expect(ids(after)).toContain(MESSAGE_BY_BASIC);
    expect(total(after)).toBe(total(before) - 1);
    await clearBlocks();
    expect(ids(await get(q, plain).expect(200))).toContain(MESSAGE_BY_PRO);
  });

  it("a user who blocked a member does not see their message as a room's last message or in its unread count", async () => {
    const room = async () => {
      const res = await get('/communities/mine?perPage=100', plain).expect(200);
      const rows = envelope<
        Array<{
          id: string;
          unreadCount: number;
          lastMessage: { id: string } | null;
        }>
      >(res).data;
      return rows.find((r) => r.id === ROOM_BY_BASIC);
    };
    const before = await room();
    expect(before?.lastMessage?.id).toBe(MESSAGE_BY_PRO);
    expect(before?.unreadCount).toBe(2);
    await plainBlocksPro();
    const after = await room();
    expect(after?.lastMessage?.id).toBe(MESSAGE_BY_BASIC);
    expect(after?.unreadCount).toBe(1);
    await clearBlocks();
    expect((await room())?.lastMessage?.id).toBe(MESSAGE_BY_PRO);
  });

  it('a user who blocked a host cannot reach their room by share link, link by id, join or messages, and each answers like a missing room', async () => {
    const missingRoom = '5a040000-0000-4000-8000-0000000000ee';
    const slug = envelope<{ slug: string }>(
      await get(`/communities/${ROOM_BY_PRO}/link`, pro).expect(200),
    ).data.slug;
    const join = () =>
      request(app.getHttpServer())
        .post(`/communities/${ROOM_BY_PRO}/join`)
        .set(as(plain));
    const entries = () => [
      get(`/communities/${ROOM_BY_PRO}/link`, plain),
      get(`/communities/links/${slug}`, plain),
      get(`/communities/${ROOM_BY_PRO}/messages`, plain),
      join(),
    ];
    const missing = [
      get(`/communities/${missingRoom}/link`, plain),
      get('/communities/links/no-such-room-s04', plain),
      get(`/communities/${missingRoom}/messages`, plain),
      request(app.getHttpServer())
        .post(`/communities/${missingRoom}/join`)
        .set(as(plain)),
    ];
    const missingAnswers = await Promise.all(missing);
    missingAnswers.forEach((r) => expect(r.status).toBe(404));

    // Before the block the link entries open (the control).
    await get(`/communities/${ROOM_BY_PRO}/link`, plain).expect(200);
    await get(`/communities/links/${slug}`, plain).expect(200);

    for (const blockIt of [plainBlocksPro, proBlocksPlain]) {
      await clearBlocks();
      await blockIt();
      const answers = await Promise.all(entries());
      answers.forEach((r, i) => {
        expect({ entry: i, status: r.status }).toEqual({
          entry: i,
          status: 404,
        });
        expect(message(r)).toBe(message(missingAnswers[i]));
      });
    }
    // Nobody joined through the blocked door.
    expect(
      await prisma.communityMembership.count({
        where: { communityId: ROOM_BY_PRO, userWawuId: USER_PLAIN },
      }),
    ).toBe(0);
    await clearBlocks();
    await get(`/communities/links/${slug}`, plain).expect(200);
  });

  it('a user already in a room keeps its link and messages after blocking its host', async () => {
    await plainBlocksPro();
    await get(`/communities/${FOUNDERS_ROOM}/link`, plain).expect(200);
    await get(`/communities/${FOUNDERS_ROOM}/messages`, plain).expect(200);
  });

  it('a user gets the same "not found" for the shelf of an account that does not exist as for one they blocked', async () => {
    const missing = await get(
      '/users/5a040000-0000-4000-8000-0000000000ef/content',
      plain,
    ).expect(404);
    await plainBlocksPro();
    const hidden = await get(`/users/${USER_PRO}/content`, plain).expect(404);
    expect(message(hidden)).toBe(message(missing));
    expect(hidden.body).toEqual(missing.body);
  });

  // ---- directory and events ---------------------------------------------

  it('a user who blocked a professional does not see their listing in the directory or on its page', async () => {
    const list = async () =>
      ids(await get('/professionals?perPage=50', plain).expect(200));
    expect(await list()).toContain(LISTING_BY_PRO);
    await get(`/professionals/${LISTING_BY_PRO}`, plain).expect(200);
    await plainBlocksPro();
    expect(await list()).not.toContain(LISTING_BY_PRO);
    await get(`/professionals/${LISTING_BY_PRO}`, plain).expect(404);
    await clearBlocks();
    expect(await list()).toContain(LISTING_BY_PRO);
  });

  it('a user who blocked a host does not see their events, even when asking for that host', async () => {
    const q = '/events?perPage=50';
    const byHost = `/events?perPage=50&host=${USER_PRO}`;
    expect(ids(await get(q, plain).expect(200))).toContain(EVENT_BY_PRO);
    await get(`/events/${EVENT_BY_PRO}`, plain).expect(200);
    await plainBlocksPro();
    expect(ids(await get(q, plain).expect(200))).not.toContain(EVENT_BY_PRO);
    expect(ids(await get(byHost, plain).expect(200))).toEqual([]);
    await get(`/events/${EVENT_BY_PRO}`, plain).expect(404);
    await clearBlocks();
    expect(ids(await get(byHost, plain).expect(200))).toContain(EVENT_BY_PRO);
  });

  // ---- the helper other features reuse -----------------------------------

  it('the hidden-people list covers both directions and is empty for a signed-out reader (wallet recipient search uses it)', async () => {
    expect(await blocks.hiddenFrom(USER_PLAIN)).toEqual([]);
    await plainBlocksPro();
    await prisma.blockedAccount.create({
      data: { userWawuId: USER_BASIC, blockedWawuId: USER_PLAIN },
    });
    expect((await blocks.hiddenFrom(USER_PLAIN)).sort()).toEqual(
      [USER_BASIC, USER_PRO].sort(),
    );
    expect(await blocks.hiddenFrom(USER_PRO)).toEqual([USER_PLAIN]);
    expect(await blocks.hiddenFrom(undefined)).toEqual([]);
  });
});
