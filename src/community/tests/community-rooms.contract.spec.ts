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
import { slugBase } from '../rooms/community-slug';
import type {
  CommunityLinkView,
  CommunityReadView,
  CommunityRoom,
} from '../rooms/community-room.type';

/** The success envelope, typed for what each route answers. */
interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
  pagination?: { currentPage: number; perPage: number; total: number };
}
/** Over the wire every date is a string. */
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };
interface WireLastMessage {
  id: string;
  text: string | null;
  imageUrl: string | null;
  sentAt: string;
  senderWawuId: string;
  sender: { wawuId: string; name: string } | null;
}
interface WireMine {
  id: string;
  name: string;
  role: 'host' | 'member';
  joinedAt: string | null;
  unreadCount: number;
  lastActivityAt: string | null;
  lastMessage: WireLastMessage | null;
}
interface WireNotification {
  kind: string;
  [key: string]: unknown;
}
function envelope<T>(res: { body: unknown }): Envelope<T> {
  return res.body as Envelope<T>;
}
function dataOf<T>(res: { body: unknown }): T {
  return envelope<T>(res).data;
}

/**
 * INBOX-01: my communities with the last message and unread count, share
 * links by slug, a cover for private rooms, and join-decision notifications.
 *
 * The capability check this spec carries end to end:
 *   "A user who asked to join a private room gets a notification when the
 *    host approves or declines; a user can open wawu/c/<slug> and land in
 *    that room."
 * So the central test opens the room from its link, asks to join, is
 * approved, finds the notification in GET /notifications, and then reads the
 * room it landed in.
 *
 * ISOLATION. Every identity is a throwaway WAWU ID registered here; every
 * room is created by those identities and deleted in afterAll (cascading to
 * memberships, messages, credit spends, links and read markers). The
 * notifications and credits rows the flows write are swept by owner id.
 */

const NON_EXISTENT_COMMUNITY = 'c3000000-0000-4000-8000-00000000dead';
const COVER = 'https://cdn.example.test/community/image/cover.jpg';

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
      fullName: `Rooms Spec ${label}`,
      email: `rooms-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2348${nonce}`,
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

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('Community rooms: mine, links, read, join decisions (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let hostToken: string;
  let hostSub: string;
  let memberToken: string;
  let memberSub: string;
  let declinedToken: string;
  let declinedSub: string;
  let outsiderToken: string;
  let outsiderSub: string;
  /** Requesters for the race tests: one per race, so no race sees another. */
  const racers: Array<{ sub: string; accessToken: string }> = [];

  /** A per-run room name, so its slug never meets a leftover from a rerun. */
  const runTag = Date.now().toString(36);
  const privateName = `Aba Tailors Circle ${runTag}`;
  let privateRoomId: string;
  let privateSlug: string;

  const ownedSubs: string[] = [];
  const server = (): App => app.getHttpServer() as App;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

    const host = await registerThrowawayIdentity('host');
    const member = await registerThrowawayIdentity('member');
    const declined = await registerThrowawayIdentity('declined');
    const outsider = await registerThrowawayIdentity('outsider');
    hostToken = host.accessToken;
    hostSub = host.sub;
    memberToken = member.accessToken;
    memberSub = member.sub;
    declinedToken = declined.accessToken;
    declinedSub = declined.sub;
    outsiderToken = outsider.accessToken;
    outsiderSub = outsider.sub;
    ownedSubs.push(host.sub, member.sub, declined.sub, outsider.sub);
    for (const label of ['racer1', 'racer2', 'racer3']) {
      const racer = await registerThrowawayIdentity(label);
      racers.push(racer);
      ownedSubs.push(racer.sub);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        // Brings NotificationModule (GET /notifications) and
        // CommunityMessageModule (posting) with it.
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
    prisma = moduleRef.get(PrismaService);

    const fixture = 'Fixture for community-rooms.contract.spec.ts.';
    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: hostSub,
          accountType: 'creator',
          interests: [],
          bio: fixture,
        },
        {
          wawuUserId: memberSub,
          accountType: 'user',
          interests: [],
          bio: fixture,
        },
        {
          wawuUserId: declinedSub,
          accountType: 'user',
          interests: [],
          bio: fixture,
        },
        {
          wawuUserId: outsiderSub,
          accountType: 'user',
          interests: [],
          bio: fixture,
        },
        ...racers.map((r) => ({
          wawuUserId: r.sub,
          accountType: 'user' as const,
          interests: [],
          bio: fixture,
        })),
      ],
    });
    // KYC pending on purpose: it gates earning, never hosting.
    await prisma.creatorState.create({
      data: {
        wawuUserId: hostSub,
        kycStatus: 'pending',
        slotsUsed: 0,
        dmEnabled: false,
      },
    });
    // The member pays 1 credit per message; give them a few.
    await prisma.creditsState.create({
      data: { userWawuId: memberSub, creditBalance: 5 },
    });
  }, 30000);

  afterAll(async () => {
    if (ownedSubs.length > 0) {
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: ownedSubs } },
      });
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: ownedSubs } },
      });
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: ownedSubs } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  describe('POST /communities/rooms (the app creates a room)', () => {
    it('401s with no token', async () => {
      await request(server())
        .post('/communities/rooms')
        .send({ name: 'No token', description: 'x', kind: 'open' })
        .expect(401);
    });

    it('403s a plain (non-creator) account', async () => {
      await request(server())
        .post('/communities/rooms')
        .set(auth(outsiderToken))
        .send({ name: 'Not a creator', description: 'x', kind: 'open' })
        .expect(403);
    });

    it('refuses a private room with no cover, and creates nothing', async () => {
      const name = `No Cover ${runTag}`;
      const res = await request(server())
        .post('/communities/rooms')
        .set(auth(hostToken))
        .send({ name, description: 'Private, no picture.', kind: 'private' })
        .expect(400);
      expect(envelope<null>(res)).toEqual({
        statusCode: 400,
        message: 'A private room needs a cover image.',
        data: null,
      });
      expect(await prisma.community.count({ where: { name } })).toBe(0);
    });

    it('creates a private room with a cover and answers with its share link', async () => {
      const res = await request(server())
        .post('/communities/rooms')
        .set(auth(hostToken))
        .send({
          name: privateName,
          description: 'Tailors in Aba, swapping patterns.',
          kind: 'private',
          imageUrl: COVER,
        })
        .expect(201);
      const room = dataOf<Wire<CommunityRoom>>(res);
      expect(room).toMatchObject({
        name: privateName,
        kind: 'private',
        hostWawuId: hostSub,
        imageUrl: COVER,
        memberCount: 0,
        messagesToday: 0,
        slug: `aba-tailors-circle-${runTag}`,
        link: `wawu/c/aba-tailors-circle-${runTag}`,
      });
      privateRoomId = room.id;
      privateSlug = room.slug;
    });

    it('gives a second room with the same name its own slug', async () => {
      const res = await request(server())
        .post('/communities/rooms')
        .set(auth(hostToken))
        .send({ name: privateName, description: 'Same name.', kind: 'open' })
        .expect(201);
      const room = dataOf<Wire<CommunityRoom>>(res);
      expect(room.slug).toBe(`${privateSlug}-2`);
      expect(room.imageUrl).toBeNull();
    });
  });

  describe('POST /communities (the web) is unchanged', () => {
    it('still creates a private room without a cover, with the same keys as before and no slug', async () => {
      const res = await request(server())
        .post('/communities')
        .set(auth(hostToken))
        .send({
          name: `Web Room ${runTag}`,
          description: 'Made the way the web makes rooms.',
          kind: 'private',
        })
        .expect(201);
      const created = dataOf<Record<string, unknown> & { id: string }>(res);
      expect(Object.keys(created).sort()).toEqual(
        [
          'description',
          'hostWawuId',
          'id',
          'imageUrl',
          'kind',
          'memberCount',
          'messagesToday',
          'name',
        ].sort(),
      );
      // GET /communities/:id is also unchanged.
      const one = await request(server())
        .get(`/communities/${created.id}`)
        .set(auth(outsiderToken))
        .expect(200);
      expect(dataOf<object>(one)).not.toHaveProperty('slug');
    });
  });

  describe('GET /communities/:id/link', () => {
    it('makes a link for a room that never had one, then keeps it', async () => {
      const web = await prisma.community.findFirstOrThrow({
        where: { name: `Web Room ${runTag}` },
      });
      expect(
        await prisma.communityLink.findUnique({
          where: { communityId: web.id },
        }),
      ).toBeNull();

      const first = await request(server())
        .get(`/communities/${web.id}/link`)
        .set(auth(outsiderToken))
        .expect(200);
      const firstLink = dataOf<CommunityLinkView>(first);
      expect(firstLink).toEqual({
        communityId: web.id,
        slug: `web-room-${runTag}`,
        link: `wawu/c/web-room-${runTag}`,
      });

      await prisma.community.update({
        where: { id: web.id },
        data: { name: 'Renamed Web Room' },
      });
      const again = await request(server())
        .get(`/communities/${web.id}/link`)
        .set(auth(hostToken))
        .expect(200);
      expect(dataOf<CommunityLinkView>(again).slug).toBe(firstLink.slug);
    });

    it('404s an unknown room and 400s an id that is not a uuid', async () => {
      await request(server())
        .get(`/communities/${NON_EXISTENT_COMMUNITY}/link`)
        .set(auth(hostToken))
        .expect(404);
      await request(server())
        .get('/communities/not-a-uuid/link')
        .set(auth(hostToken))
        .expect(400);
    });

    it('401s with no token', async () => {
      await request(server())
        .get(`/communities/${NON_EXISTENT_COMMUNITY}/link`)
        .expect(401);
    });
  });

  describe('GET /communities/links/:slug (open wawu/c/<slug>)', () => {
    it('opens the room the link names', async () => {
      const res = await request(server())
        .get(`/communities/links/${privateSlug}`)
        .set(auth(outsiderToken))
        .expect(200);
      expect(dataOf<Wire<CommunityRoom>>(res)).toMatchObject({
        id: privateRoomId,
        name: privateName,
        kind: 'private',
        slug: privateSlug,
        link: `wawu/c/${privateSlug}`,
      });
    });

    it('opens it when typed in capitals too', async () => {
      const res = await request(server())
        .get(`/communities/links/${privateSlug.toUpperCase()}`)
        .set(auth(outsiderToken))
        .expect(200);
      expect(dataOf<Wire<CommunityRoom>>(res).id).toBe(privateRoomId);
    });

    it('404s a link nobody has, and one that cannot be a link', async () => {
      for (const slug of ['no-such-room-anywhere', 'Not%20a%20slug!', '-x-']) {
        const res = await request(server())
          .get(`/communities/links/${slug}`)
          .set(auth(outsiderToken))
          .expect(404);
        expect(envelope<null>(res).message).toBe('No community has this link.');
      }
    });

    it('401s with no token', async () => {
      await request(server())
        .get(`/communities/links/${privateSlug}`)
        .expect(401);
    });
  });

  describe('join decisions are notified (I31: "We\'ll let you know when she answers")', () => {
    const notificationsOf = async (
      token: string,
    ): Promise<WireNotification[]> => {
      const res = await request(server())
        .get('/notifications')
        .set(auth(token))
        .expect(200);
      return dataOf<{ items: { data: WireNotification[] } }>(res).items.data;
    };

    it('a user opens the link, asks to join, is approved, is told, and lands in the room', async () => {
      // Open wawu/c/<slug>.
      const opened = await request(server())
        .get(`/communities/links/${privateSlug}`)
        .set(auth(memberToken))
        .expect(200);
      const roomId = dataOf<Wire<CommunityRoom>>(opened).id;

      // Ask to join: a private room answers pending, and the room stays shut.
      const asked = await request(server())
        .post(`/communities/${roomId}/join`)
        .set(auth(memberToken))
        .expect(200);
      expect(dataOf<{ status: string }>(asked).status).toBe('pending');
      await request(server())
        .get(`/communities/${roomId}/messages`)
        .set(auth(memberToken))
        .expect(403);
      expect(await notificationsOf(memberToken)).toEqual([]);

      // The host approves.
      await request(server())
        .post(`/communities/${roomId}/requests/${memberSub}/approve`)
        .set(auth(hostToken))
        .expect(200);

      const notes = await notificationsOf(memberToken);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        userWawuId: memberSub,
        kind: 'community_join_approved',
        title: 'Request approved',
        body: `The host of “${privateName}” approved your request to join. You're in.`,
        tone: 'success',
        actionLabel: 'Open room',
        actionHref: `/communities/${roomId}`,
        read: false,
      });
      // Nobody else was told; the host least of all.
      expect(await notificationsOf(hostToken)).toEqual([]);

      // Landed: the room now reads for them.
      await request(server())
        .get(`/communities/${roomId}/messages`)
        .set(auth(memberToken))
        .expect(200);

      // Approving again (a stale queue, a double tap) tells nobody twice.
      await request(server())
        .post(`/communities/${roomId}/requests/${memberSub}/approve`)
        .set(auth(hostToken))
        .expect(200);
      expect(await notificationsOf(memberToken)).toHaveLength(1);
    });

    it('a user whose request is declined is told, once', async () => {
      await request(server())
        .post(`/communities/${privateRoomId}/join`)
        .set(auth(declinedToken))
        .expect(200);
      await request(server())
        .delete(`/communities/${privateRoomId}/requests/${declinedSub}`)
        .set(auth(hostToken))
        .expect(200);

      const notes = await notificationsOf(declinedToken);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        kind: 'community_join_declined',
        title: 'Request declined',
        body: `The host of “${privateName}” declined your request to join.`,
        tone: 'neutral',
        actionLabel: null,
        actionHref: null,
      });

      // Declining again, with nothing left to decline, sends nothing.
      await request(server())
        .delete(`/communities/${privateRoomId}/requests/${declinedSub}`)
        .set(auth(hostToken))
        .expect(200);
      expect(await notificationsOf(declinedToken)).toHaveLength(1);
    });
  });

  describe('GET /communities/mine and POST /communities/:id/read', () => {
    const mine = async (token: string): Promise<Envelope<WireMine[]>> =>
      envelope<WireMine[]>(
        await request(server())
          .get('/communities/mine')
          .set(auth(token))
          .expect(200),
      );

    const post = (token: string, text: string) =>
      request(server())
        .post(`/communities/${privateRoomId}/messages`)
        .set(auth(token))
        .send({ text })
        .expect(201);

    it('401s with no token', async () => {
      await request(server()).get('/communities/mine').expect(401);
    });

    it('a user with no rooms gets an empty page', async () => {
      const body = await mine(outsiderToken);
      expect(body.data).toEqual([]);
      expect(body.pagination?.total).toBe(0);
    });

    it('a waiting request is not listed', async () => {
      await request(server())
        .post(`/communities/${privateRoomId}/join`)
        .set(auth(declinedToken))
        .expect(200);
      const body = await mine(declinedToken);
      expect(body.data).toEqual([]);
    });

    it('a member sees the last message and how many they have not read', async () => {
      await tick();
      await post(hostToken, 'Welcome, everyone.');
      await tick();
      await post(hostToken, 'Patterns go up on Friday.');

      const body = await mine(memberToken);
      expect(body.data).toHaveLength(1);
      const row = body.data[0];
      expect(row).toMatchObject({
        id: privateRoomId,
        name: privateName,
        role: 'member',
        slug: privateSlug,
        link: `wawu/c/${privateSlug}`,
        memberCount: 1,
        unreadCount: 2,
        lastMessage: {
          text: 'Patterns go up on Friday.',
          imageUrl: null,
          senderWawuId: hostSub,
          sender: { wawuId: hostSub, name: 'Rooms Spec host' },
        },
      });
      expect(row.joinedAt).toEqual(expect.any(String));
      expect(row.lastActivityAt).toBe(row.lastMessage?.sentAt);
    });

    it('their own message is never unread to them, and is unread to the host', async () => {
      await tick();
      await post(memberToken, 'Thank you for having me.');

      const member = (await mine(memberToken)).data[0];
      expect(member.unreadCount).toBe(2);
      expect(member.lastMessage?.text).toBe('Thank you for having me.');

      // The host has never opened the room: everything from others counts.
      const hostRows = (await mine(hostToken)).data;
      const hostRow = hostRows.find((r) => r.id === privateRoomId);
      expect(hostRow).toMatchObject({
        role: 'host',
        joinedAt: null,
        unreadCount: 1,
      });
      // Newest activity first: the room with messages leads the host's list.
      expect(hostRows[0].id).toBe(privateRoomId);
      expect(hostRows.length).toBeGreaterThanOrEqual(3);
    });

    it('opening the room clears the count, and only newer messages count after', async () => {
      const read = await request(server())
        .post(`/communities/${privateRoomId}/read`)
        .set(auth(memberToken))
        .expect(200);
      const marked = dataOf<Wire<CommunityReadView>>(read);
      expect(marked.communityId).toBe(privateRoomId);
      expect(Number.isNaN(Date.parse(marked.lastReadAt))).toBe(false);
      expect((await mine(memberToken)).data[0].unreadCount).toBe(0);

      await tick();
      await post(hostToken, 'One more thing.');
      expect((await mine(memberToken)).data[0].unreadCount).toBe(1);

      // Reading twice is fine.
      await request(server())
        .post(`/communities/${privateRoomId}/read`)
        .set(auth(memberToken))
        .expect(200);
      await request(server())
        .post(`/communities/${privateRoomId}/read`)
        .set(auth(memberToken))
        .expect(200);
      expect((await mine(memberToken)).data[0].unreadCount).toBe(0);
    });

    it('the host can mark their own room read', async () => {
      await request(server())
        .post(`/communities/${privateRoomId}/read`)
        .set(auth(hostToken))
        .expect(200);
      const hostRow = (await mine(hostToken)).data.find(
        (r) => r.id === privateRoomId,
      );
      expect(hostRow?.unreadCount).toBe(0);
    });

    it('someone who cannot read the room cannot mark it read', async () => {
      // `declined` is waiting again (asked in an earlier test): still shut.
      const res = await request(server())
        .post(`/communities/${privateRoomId}/read`)
        .set(auth(declinedToken))
        .expect(403);
      expect(envelope<null>(res).message).toBe(
        'Join this community to read or post in it.',
      );
      await request(server())
        .post(`/communities/${privateRoomId}/read`)
        .set(auth(outsiderToken))
        .expect(403);
      await request(server())
        .post(`/communities/${NON_EXISTENT_COMMUNITY}/read`)
        .set(auth(memberToken))
        .expect(404);
      await request(server())
        .post('/communities/not-a-uuid/read')
        .set(auth(memberToken))
        .expect(400);
    });

    it('pages the list', async () => {
      const body = envelope<WireMine[]>(
        await request(server())
          .get('/communities/mine?page=1&perPage=1')
          .set(auth(hostToken))
          .expect(200),
      );
      expect(body.data).toHaveLength(1);
      expect(body.pagination?.total).toBeGreaterThanOrEqual(3);
      expect(body.pagination?.perPage).toBe(1);
    });

    it('a member who leaves drops off the list', async () => {
      await request(server())
        .delete(`/communities/${privateRoomId}/join`)
        .set(auth(memberToken))
        .expect(200);
      expect((await mine(memberToken)).data).toEqual([]);
    });
  });

  /**
   * Answers sent at the same time (two host devices, a double tap on a slow
   * network). Each race runs several rounds; every round must end with one
   * outcome and one notification. Before the fix, parallel approvals wrote
   * two or three "Request approved" rows in some rounds.
   */
  describe('answers that race', () => {
    const ROUNDS = 5;

    const ask = (token: string) =>
      request(server())
        .post(`/communities/${privateRoomId}/join`)
        .set(auth(token))
        .expect(200);
    const approve = (sub: string) =>
      request(server())
        .post(`/communities/${privateRoomId}/requests/${sub}/approve`)
        .set(auth(hostToken));
    const decline = (sub: string) =>
      request(server())
        .delete(`/communities/${privateRoomId}/requests/${sub}`)
        .set(auth(hostToken));
    const answersTo = (sub: string) =>
      prisma.notification.findMany({
        where: { userWawuId: sub, kind: { startsWith: 'community_join' } },
        select: { kind: true },
      });
    /** Back to "not a member, never told", for the next round. */
    const reset = async (sub: string) => {
      await prisma.communityMembership.deleteMany({
        where: { communityId: privateRoomId, userWawuId: sub },
      });
      await prisma.notification.deleteMany({ where: { userWawuId: sub } });
    };

    it('three approvals at once: one approval, one notification', async () => {
      const racer = racers[0];
      for (let round = 0; round < ROUNDS; round += 1) {
        await reset(racer.sub);
        await ask(racer.accessToken);
        const answers = await Promise.all([
          approve(racer.sub),
          approve(racer.sub),
          approve(racer.sub),
        ]);
        expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
        for (const a of answers) {
          expect(dataOf<{ status: string }>(a).status).toBe('joined');
        }
        expect(await answersTo(racer.sub)).toEqual([
          { kind: 'community_join_approved' },
        ]);
      }
    });

    it('three declines at once: one decline, one notification', async () => {
      const racer = racers[1];
      for (let round = 0; round < ROUNDS; round += 1) {
        await reset(racer.sub);
        await ask(racer.accessToken);
        const answers = await Promise.all([
          decline(racer.sub),
          decline(racer.sub),
          decline(racer.sub),
        ]);
        expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
        for (const a of answers) {
          expect(dataOf<{ declined: boolean }>(a)).toEqual({ declined: true });
        }
        expect(await answersTo(racer.sub)).toEqual([
          { kind: 'community_join_declined' },
        ]);
        expect(
          await prisma.communityMembership.count({
            where: { communityId: privateRoomId, userWawuId: racer.sub },
          }),
        ).toBe(0);
      }
    });

    it('an approval and a decline at once: one of them wins, and only it is told', async () => {
      const racer = racers[2];
      for (let round = 0; round < ROUNDS; round += 1) {
        await reset(racer.sub);
        await ask(racer.accessToken);
        const [approved, declined] = await Promise.all([
          approve(racer.sub),
          decline(racer.sub),
        ]);
        const row = await prisma.communityMembership.findUnique({
          where: {
            userWawuId_communityId: {
              userWawuId: racer.sub,
              communityId: privateRoomId,
            },
          },
        });
        const told = await answersTo(racer.sub);
        if (row) {
          // The approval won: they are in, the decline was refused.
          expect(approved.status).toBe(200);
          expect(declined.status).toBe(409);
          expect(row.status).toBe('joined');
          expect(told).toEqual([{ kind: 'community_join_approved' }]);
        } else {
          // The decline won: the request is gone, the approval found nothing.
          expect(declined.status).toBe(200);
          expect(approved.status).toBe(404);
          expect(envelope<null>(approved).message).toBe(
            'No join request from this user for this community.',
          );
          expect(told).toEqual([{ kind: 'community_join_declined' }]);
        }
      }
    });
  });

  describe('slugBase', () => {
    it('drops accents and punctuation, and falls back to "room"', () => {
      expect(slugBase("Àba Tailors' Circle!!")).toBe('aba-tailors-circle');
      expect(slugBase('  --  ')).toBe('room');
      expect(slugBase('x'.repeat(80))).toHaveLength(48);
    });
  });
});
