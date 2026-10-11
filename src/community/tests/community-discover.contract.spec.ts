// Run against wawu_hub_test (set DATABASE_URL before invoking jest), the same
// convention as every other contract spec in this repo.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CommunityModule } from '../community.module';

/** The success envelope, typed for what each route answers. */
interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
  pagination?: {
    currentPage: number;
    nextPage: number | null;
    perPage: number;
    total: number;
  };
}
interface WireRoomView {
  id: string;
  name: string;
  kind: 'open' | 'private';
  hostWawuId: string;
  imageUrl: string | null;
  memberCount: number;
  messagesToday: number;
  slug: string;
  link: string;
  role: 'host' | 'member' | 'pending' | 'none';
  messageCostInCredits: number;
}
interface WireSuggested {
  id: string;
  name: string;
  kind: 'open' | 'private';
  hostWawuId: string;
  memberCount: number;
  messagesToday: number;
}
function envelope<T>(res: { body: unknown }): Envelope<T> {
  return res.body as Envelope<T>;
}
function dataOf<T>(res: { body: unknown }): T {
  return envelope<T>(res).data;
}

/**
 * INBOX-05: what the Communities list (I24) and a room (I25, I26) read that
 * INBOX-01 does not serve.
 *
 *   GET /communities/message-cost   the card's "1 credit per message you send"
 *   GET /communities/:id/room       the room header, where the caller stands,
 *                                   and what one message costs them there
 *   GET /communities/suggested      rooms the caller could join, most members
 *                                   first
 *
 * The price a route states must be the price a send charges, so the cost
 * tests post a real message and read the balance after it.
 *
 * ISOLATION. Every identity is a throwaway WAWU ID registered here; every
 * room is hosted by one of them and deleted in afterAll (cascading to
 * memberships, messages, credit spends and links). Orders are checked only
 * among this file's own rooms, so rooms other specs or the seed left behind
 * never change an answer here.
 */

const NON_EXISTENT_COMMUNITY = 'c3000000-0000-4000-8000-00000000dead';

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

let throwawayNonce = 0;
async function registerThrowawayIdentity(
  label: string,
): Promise<{ sub: string; accessToken: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(throwawayNonce += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Discover Spec ${label}`,
      email: `discover-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id register failed for ${label}: ${res.status}`);
  }
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, accessToken: body.accessToken };
}

describe('Communities for the app: room view, message cost, suggestions (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  type Person = { sub: string; accessToken: string };
  let host: Person;
  let otherHost: Person;
  let blockedHost: Person;
  let viewer: Person;
  const joiners: Person[] = [];

  const runTag = Date.now().toString(36);
  /** Room ids by a short name, all hosted by this file's identities. */
  const rooms: Record<string, string> = {};
  const ownedSubs: string[] = [];
  const server = (): App => app.getHttpServer() as App;
  const auth = (p: Person) => ({ Authorization: `Bearer ${p.accessToken}` });

  async function makeRoom(
    key: string,
    hostSub: string,
    kind: 'open' | 'private',
    name: string,
  ): Promise<string> {
    const room = await prisma.community.create({
      data: {
        name,
        description: `Fixture for community-discover.contract.spec.ts (${key}).`,
        hostWawuId: hostSub,
        kind,
      },
    });
    rooms[key] = room.id;
    return room.id;
  }

  async function addMembers(
    communityId: string,
    people: Person[],
    status: 'joined' | 'pending' = 'joined',
  ): Promise<void> {
    await prisma.communityMembership.createMany({
      data: people.map((p) => ({
        userWawuId: p.sub,
        communityId,
        status,
        joinedAt: status === 'joined' ? new Date() : null,
      })),
    });
  }

  /** Every suggestion for `who`, walked page by page to the end. */
  async function allSuggestions(
    who: Person,
    perPage = 100,
  ): Promise<{ items: WireSuggested[]; pages: number; total: number }> {
    const items: WireSuggested[] = [];
    let page = 1;
    let pages = 0;
    let total = -1;
    for (;;) {
      const res = await request(server())
        .get(`/communities/suggested?page=${page}&perPage=${perPage}`)
        .set(auth(who))
        .expect(200);
      const body = envelope<WireSuggested[]>(res);
      items.push(...body.data);
      pages += 1;
      total = body.pagination!.total;
      if (body.pagination!.nextPage === null) break;
      page = body.pagination!.nextPage;
      if (pages > 50) throw new Error('suggestions never ended');
    }
    return { items, pages, total };
  }

  const ours = (items: WireSuggested[]) =>
    items.filter((c) => Object.values(rooms).includes(c.id));

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    host = await registerThrowawayIdentity('host');
    otherHost = await registerThrowawayIdentity('otherhost');
    blockedHost = await registerThrowawayIdentity('blockedhost');
    viewer = await registerThrowawayIdentity('viewer');
    for (let i = 0; i < 4; i += 1) {
      joiners.push(await registerThrowawayIdentity(`joiner${i}`));
    }
    ownedSubs.push(
      host.sub,
      otherHost.sub,
      blockedHost.sub,
      viewer.sub,
      ...joiners.map((j) => j.sub),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityModule,
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);

    const fixture = 'Fixture for community-discover.contract.spec.ts.';
    await prisma.userProfile.createMany({
      data: ownedSubs.map((sub) => ({
        wawuUserId: sub,
        accountType:
          sub === host.sub || sub === otherHost.sub || sub === blockedHost.sub
            ? ('creator' as const)
            : ('user' as const),
        interests: [],
        bio: fixture,
      })),
    });
    // The viewer pays per message; three credits are enough for the tests.
    await prisma.creditsState.create({
      data: { userWawuId: viewer.sub, creditBalance: 3 },
    });

    // Four open rooms with 3, 2, 2 and 0 members, two of them tied on
    // count so the name decides; a private one with 1; a room the viewer
    // hosts; one they joined; one they asked to join; one hosted by somebody
    // who blocked them.
    const big = await makeRoom('big', host.sub, 'open', `Zz Big ${runTag}`);
    await addMembers(big, joiners.slice(0, 3));
    const tieB = await makeRoom(
      'tieB',
      otherHost.sub,
      'open',
      `Bb Tie ${runTag}`,
    );
    await addMembers(tieB, joiners.slice(0, 2));
    const tieA = await makeRoom('tieA', host.sub, 'open', `Aa Tie ${runTag}`);
    await addMembers(tieA, joiners.slice(1, 3));
    await makeRoom('empty', otherHost.sub, 'open', `Mm Empty ${runTag}`);
    const priv = await makeRoom(
      'private',
      host.sub,
      'private',
      `Pp Private ${runTag}`,
    );
    await addMembers(priv, [joiners[3]]);
    // Pending requests are not members: they never raise a room's rank.
    await addMembers(priv, joiners.slice(0, 2), 'pending');
    await makeRoom('mine', viewer.sub, 'open', `Viewer Hosts ${runTag}`);
    const joined = await makeRoom(
      'joined',
      otherHost.sub,
      'open',
      `Viewer Joined ${runTag}`,
    );
    await addMembers(joined, [viewer]);
    const asked = await makeRoom(
      'asked',
      otherHost.sub,
      'private',
      `Viewer Asked ${runTag}`,
    );
    await addMembers(asked, [viewer], 'pending');
    const hidden = await makeRoom(
      'hidden',
      blockedHost.sub,
      'open',
      `Hidden Host ${runTag}`,
    );
    await addMembers(hidden, joiners);
    // A room the viewer was already in when its host blocked them.
    const kept = await makeRoom(
      'kept',
      blockedHost.sub,
      'open',
      `Kept Room ${runTag}`,
    );
    await addMembers(kept, [viewer]);
    await prisma.blockedAccount.create({
      data: { userWawuId: blockedHost.sub, blockedWawuId: viewer.sub },
    });
  }, 30000);

  afterAll(async () => {
    if (ownedSubs.length > 0) {
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: ownedSubs } },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [
            { userWawuId: { in: ownedSubs } },
            { blockedWawuId: { in: ownedSubs } },
          ],
        },
      });
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: ownedSubs } },
      });
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: ownedSubs } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  describe('GET /communities/message-cost', () => {
    it('401s with no token', async () => {
      await request(server()).get('/communities/message-cost').expect(401);
    });

    it('states the price a send then charges', async () => {
      const cost = dataOf<{ creditsPerMessage: number }>(
        await request(server())
          .get('/communities/message-cost')
          .set(auth(viewer))
          .expect(200),
      );
      expect(Object.keys(cost)).toEqual(['creditsPerMessage']);
      expect(Number.isInteger(cost.creditsPerMessage)).toBe(true);
      expect(cost.creditsPerMessage).toBeGreaterThan(0);

      const before = await prisma.creditsState.findUniqueOrThrow({
        where: { userWawuId: viewer.sub },
      });
      const sent = await request(server())
        .post(`/communities/${rooms.joined}/messages`)
        .set(auth(viewer))
        .send({ text: 'Priced as stated.' })
        .expect(201);
      expect(dataOf<{ costInCredits: number }>(sent).costInCredits).toBe(
        cost.creditsPerMessage,
      );
      const after = await prisma.creditsState.findUniqueOrThrow({
        where: { userWawuId: viewer.sub },
      });
      expect(before.creditBalance - after.creditBalance).toBe(
        cost.creditsPerMessage,
      );
    });
  });

  describe('GET /communities/:id/room', () => {
    it('401s with no token, 400s a malformed id, 404s an unknown room', async () => {
      await request(server()).get(`/communities/${rooms.big}/room`).expect(401);
      await request(server())
        .get('/communities/not-a-uuid/room')
        .set(auth(viewer))
        .expect(400);
      const res = await request(server())
        .get(`/communities/${NON_EXISTENT_COMMUNITY}/room`)
        .set(auth(viewer))
        .expect(404);
      expect(envelope<null>(res).message).toBe('Community not found');
    });

    it('gives the host role host and a free message, and the room its counts and link', async () => {
      const room = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.big}/room`)
          .set(auth(host))
          .expect(200),
      );
      expect(room).toMatchObject({
        id: rooms.big,
        name: `Zz Big ${runTag}`,
        kind: 'open',
        hostWawuId: host.sub,
        memberCount: 3,
        role: 'host',
        messageCostInCredits: 0,
      });
      expect(room.link).toBe(`wawu/c/${room.slug}`);
      expect(Object.keys(room).sort()).toEqual(
        [
          'description',
          'hostWawuId',
          'id',
          'imageUrl',
          'kind',
          'link',
          'memberCount',
          'messageCostInCredits',
          'messagesToday',
          'name',
          'role',
          'slug',
        ].sort(),
      );

      // The stated 0 is what the host's own message costs.
      const sent = await request(server())
        .post(`/communities/${rooms.big}/messages`)
        .set(auth(host))
        .send({ text: 'Welcome, all.' })
        .expect(201);
      expect(dataOf<{ costInCredits: number }>(sent).costInCredits).toBe(0);
      const again = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.big}/room`)
          .set(auth(host))
          .expect(200),
      );
      expect(again.messagesToday).toBe(room.messagesToday + 1);
      expect(again.slug).toBe(room.slug);
    });

    it('gives a member role member and the metered price, the same as message-cost', async () => {
      const cost = dataOf<{ creditsPerMessage: number }>(
        await request(server())
          .get('/communities/message-cost')
          .set(auth(viewer))
          .expect(200),
      );
      const room = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.joined}/room`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(room.role).toBe('member');
      expect(room.messageCostInCredits).toBe(cost.creditsPerMessage);
    });

    it('gives someone who asked to join a private room role pending, and a stranger role none', async () => {
      const asked = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.asked}/room`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(asked).toMatchObject({ kind: 'private', role: 'pending' });
      const stranger = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.big}/room`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(stranger).toMatchObject({ kind: 'open', role: 'none' });
      // A pending request is not a member: the private room counts 1.
      const priv = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.private}/room`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(priv).toMatchObject({ memberCount: 1, role: 'none' });
    });

    it('answers 404 for a room whose host hid the caller, as GET /communities/:id does', async () => {
      const res = await request(server())
        .get(`/communities/${rooms.hidden}/room`)
        .set(auth(viewer))
        .expect(404);
      const plain = await request(server())
        .get(`/communities/${rooms.hidden}`)
        .set(auth(viewer))
        .expect(404);
      expect(envelope<null>(res).message).toBe(envelope<null>(plain).message);
      // Somebody already in a room keeps it after its host hides them.
      const kept = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.kept}/room`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(kept.role).toBe('member');
      // And the hidden room reads normally for anybody the host did not hide.
      const member = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.hidden}/room`)
          .set(auth(joiners[0]))
          .expect(200),
      );
      expect(member.role).toBe('member');
    });
  });

  describe('GET /communities/suggested', () => {
    it('401s with no token and refuses a page size out of range', async () => {
      await request(server()).get('/communities/suggested').expect(401);
      await request(server())
        .get('/communities/suggested?page=1&perPage=0')
        .set(auth(viewer))
        .expect(400);
      await request(server())
        .get('/communities/suggested?page=1&perPage=101')
        .set(auth(viewer))
        .expect(400);
    });

    it('lists only rooms the caller could join, most members first, then by name', async () => {
      const { items } = await allSuggestions(viewer);
      const mine = ours(items);
      expect(mine.map((c) => c.id)).toEqual([
        rooms.big,
        rooms.tieA,
        rooms.tieB,
        rooms.private,
        rooms.empty,
      ]);
      expect(mine.map((c) => c.memberCount)).toEqual([3, 2, 2, 1, 0]);
      // Not the room they host, are in, asked to join, or whose host hid them.
      for (const key of ['mine', 'joined', 'asked', 'hidden', 'kept']) {
        expect(items.some((c) => c.id === rooms[key])).toBe(false);
      }
      // Over every room, not only this file's: never fewer members after more.
      const counts = items.map((c) => c.memberCount);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    });

    it('pages without repeating or skipping a room, and the total is the list', async () => {
      const whole = await allSuggestions(viewer, 100);
      const paged = await allSuggestions(viewer, 2);
      expect(paged.items.map((c) => c.id)).toEqual(
        whole.items.map((c) => c.id),
      );
      expect(new Set(paged.items.map((c) => c.id)).size).toBe(
        paged.items.length,
      );
      expect(paged.total).toBe(whole.items.length);
      expect(paged.pages).toBe(Math.max(1, Math.ceil(whole.total / 2)));
    });

    it('drops a room once the caller joins it, and the host sees the others', async () => {
      await request(server())
        .post(`/communities/${rooms.empty}/join`)
        .set(auth(viewer))
        .expect(200);
      const after = ours((await allSuggestions(viewer)).items);
      expect(after.map((c) => c.id)).toEqual([
        rooms.big,
        rooms.tieA,
        rooms.tieB,
        rooms.private,
      ]);
      const room = dataOf<WireRoomView>(
        await request(server())
          .get(`/communities/${rooms.empty}/room`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(room).toMatchObject({ role: 'member', memberCount: 1 });

      // The host of big, tieA and private is offered neither of those, and is
      // offered the viewer's own room, which they are not in.
      const forHost = (await allSuggestions(host)).items.map((c) => c.id);
      for (const key of ['big', 'tieA', 'private']) {
        expect(forHost).not.toContain(rooms[key]);
      }
      expect(forHost).toContain(rooms.mine);
      expect(forHost).toContain(rooms.tieB);
    });

    it('answers each room with the same counts as GET /communities/:id', async () => {
      const [first] = ours((await allSuggestions(viewer)).items);
      const plain = dataOf<WireSuggested>(
        await request(server())
          .get(`/communities/${first.id}`)
          .set(auth(viewer))
          .expect(200),
      );
      expect(first).toEqual(plain);
    });
  });
});
