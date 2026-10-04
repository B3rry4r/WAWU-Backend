// Contract tests for the inbox (task INBOX-07).
//
// The capability check the task names, end to end over HTTP with real tokens
// from the local mock WAWU ID:
//   A user with two unread chats and one unanswered paid question sees 3 on
//   the Inbox tab, and 2 after opening one chat.
// plus what the list is made of: one stable order across three sources whose
// rows tie and arrive while paging, unread counts that equal each source's
// own, the badge equal to the sum of the rows, and who may and may not appear.
//
// Every identity is a throwaway registered by this spec, and every row it
// writes is removed in afterAll (README, test hygiene).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../../chat/chat.module';
import { CommunityModule } from '../../community/community.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { InboxModule } from '../inbox.module';
import type { ChatSummaryPage } from '../../chat/chat-view.type';
import type { PaidDmThreadPage } from '../../direct-message/paid-dm-view.type';
import type { MyCommunity } from '../../community/rooms/community-room.type';
import type { InboxItem, InboxPage, InboxUnread } from '../inbox-view.type';

const data = <T>(res: Response): T => (res.body as { data: T }).data;

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const HOUR = 3_600_000;

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

interface Person {
  sub: string;
  token: string;
  fullName: string;
}

let nonceSeq = 0;
async function registerPerson(label: string): Promise<Person> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const fullName = `Inbox Spec ${label}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName,
      email: `inbox-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken, fullName };
}

/** Rows sort by time, then key, both descending: the order the route promises. */
function sorted(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const at = (x: InboxItem) =>
      x.lastActivityAt ? Date.parse(x.lastActivityAt) : 0;
    if (at(a) !== at(b)) return at(b) - at(a);
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

describe('Inbox (contract, INBOX-07)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;

  // The capability check: Hana is the user; Ife and Jide chat with her; Kemi
  // asks her a paid question. Ada owns the crafted data; Bola and Chidi are
  // the people in it. Efe is the paging person. Dayo has no Hub profile.
  let hana: Person;
  let ife: Person;
  let jide: Person;
  let kemi: Person;
  let ada: Person;
  let bola: Person;
  let chidi: Person;
  let efe: Person;
  let dayo: Person;

  const createdChats: string[] = [];
  const createdRooms: string[] = [];
  const createdDms: string[] = [];
  const extraProfiles: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (who: { token: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${who.token}`).send(body),
  });
  const people = () => [hana, ife, jide, kemi, ada, bola, chidi, efe, dayo];

  const inbox = async (who: Person, qs = ''): Promise<InboxPage> =>
    data<InboxPage>(await as(who).get(`/inbox${qs}`).expect(200));
  const unread = async (who: Person): Promise<InboxUnread> =>
    data<InboxUnread>(await as(who).get('/inbox/unread').expect(200));
  /** Every page, following the cursor with the given page size. */
  const everyRow = async (who: Person, limit: number, kind = '') => {
    const out: InboxItem[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const qs: string = `?limit=${limit}${kind ? `&kind=${kind}` : ''}${cursor ? `&cursor=${cursor}` : ''}`;
      const page: InboxPage = await inbox(who, qs);
      out.push(...page.items);
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 500);
    return out;
  };

  // ── fixtures written straight into the tables, at times the test chooses ──

  async function chatRow(
    a: string,
    b: string,
    messages: { from: string; at: Date; text?: string; kind?: string }[],
    mark?: { user: string; at: Date; messageId?: string },
  ): Promise<{ id: string; messageIds: string[] }> {
    const [userAWawuId, userBWawuId] = [a, b].sort();
    const latest = messages.reduce(
      (t, m) => Math.max(t, m.at.getTime()),
      Date.now() - 30 * 24 * HOUR,
    );
    const conv = await prisma.chatConversation.create({
      data: {
        userAWawuId,
        userBWawuId,
        createdAt: new Date(latest - 1000),
        lastActivityAt: new Date(latest),
        participants: {
          create: [
            {
              wawuUserId: a,
              ...(mark?.user === a
                ? { lastReadAt: mark.at, lastReadMessageId: mark.messageId }
                : {}),
            },
            {
              wawuUserId: b,
              ...(mark?.user === b
                ? { lastReadAt: mark.at, lastReadMessageId: mark.messageId }
                : {}),
            },
          ],
        },
      },
    });
    createdChats.push(conv.id);
    const messageIds: string[] = [];
    for (const m of messages) {
      const row = await prisma.chatMessage.create({
        data: {
          conversationId: conv.id,
          senderWawuId: m.from,
          kind: m.kind ?? 'text',
          text: m.text ?? 'hello',
          createdAt: m.at,
        },
      });
      messageIds.push(row.id);
    }
    return { id: conv.id, messageIds };
  }

  async function roomRow(opts: {
    host: string;
    name: string;
    kind?: 'open' | 'private';
    members?: {
      user: string;
      status?: 'joined' | 'pending';
      joinedAt?: Date;
    }[];
    messages?: { sender: string; at: Date; text?: string }[];
    marker?: { user: string; at: Date };
  }): Promise<string> {
    const room = await prisma.community.create({
      data: {
        name: opts.name,
        description: 'Fixture for inbox.contract.spec.ts.',
        hostWawuId: opts.host,
        kind: opts.kind ?? 'open',
      },
    });
    createdRooms.push(room.id);
    for (const m of opts.members ?? []) {
      await prisma.communityMembership.create({
        data: {
          userWawuId: m.user,
          communityId: room.id,
          status: m.status ?? 'joined',
          joinedAt: m.status === 'pending' ? null : (m.joinedAt ?? new Date()),
        },
      });
    }
    for (const m of opts.messages ?? []) {
      await prisma.communityMessage.create({
        data: {
          communityId: room.id,
          senderWawuId: m.sender,
          text: m.text ?? 'room hello',
          sentAt: m.at,
        },
      });
    }
    if (opts.marker) {
      await prisma.communityReadMarker.create({
        data: {
          userWawuId: opts.marker.user,
          communityId: room.id,
          lastReadAt: opts.marker.at,
        },
      });
    }
    return room.id;
  }

  async function dmRow(opts: {
    from: string;
    to: string;
    at: Date;
    text?: string;
    status?: 'awaiting_response' | 'responded' | 'refunded';
    deadlineAt?: Date;
    replies?: { at: Date; text: string }[];
  }): Promise<string> {
    const id = randomUUID();
    createdDms.push(id);
    await prisma.directMessage.create({
      data: {
        id,
        creatorWawuId: opts.to,
        senderWawuId: opts.from,
        text: opts.text ?? 'a paid question',
        amount: 1500,
        status: opts.status ?? 'awaiting_response',
        sentAt: opts.at,
        deadlineAt: opts.deadlineAt ?? new Date(Date.now() + 10 * HOUR),
        flutterwaveTxRef: `inbox-spec-${id}`,
        responseWindowHours: 24,
        replies: {
          create: (opts.replies ?? []).map((r) => ({
            creatorWawuId: opts.to,
            text: r.text,
            createdAt: r.at,
          })),
        },
      },
    });
    return id;
  }

  /** A person nobody has an account for: what a deleted account looks like. */
  const ghost = () => randomUUID();

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    hana = await registerPerson('Hana');
    ife = await registerPerson('Ife');
    jide = await registerPerson('Jide');
    kemi = await registerPerson('Kemi');
    ada = await registerPerson('Ada');
    bola = await registerPerson('Bola');
    chidi = await registerPerson('Chidi');
    efe = await registerPerson('Efe');
    dayo = await registerPerson('Dayo');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        ChatModule,
        CommunityModule,
        DirectMessageModule,
        InboxModule,
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

    for (const p of people().filter((x) => x !== dayo)) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `inboxspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for inbox.contract.spec.ts.',
          interests: [],
        },
      });
    }
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      const ids = people().map((p) => p.sub);
      await prisma.chatConversation.deleteMany({
        where: {
          OR: [
            { id: { in: createdChats } },
            { userAWawuId: { in: ids } },
            { userBWawuId: { in: ids } },
          ],
        },
      });
      await prisma.community.deleteMany({
        where: { id: { in: createdRooms } },
      });
      await prisma.directMessage.deleteMany({
        where: { id: { in: createdDms } },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: ids } }, { blockedWawuId: { in: ids } }],
        },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: [...ids, ...extraProfiles] } },
      });
    }
    if (app) await app.close();
    mock?.kill();
  });

  describe('who may ask', () => {
    it('401s with no token', async () => {
      await http().get('/inbox').expect(401);
      await http().get('/inbox/unread').expect(401);
    });

    it('is empty, with a badge of 0, for a person with nothing yet', async () => {
      expect(await inbox(hana)).toEqual({ items: [], nextCursor: null });
      expect(await unread(hana)).toEqual({
        total: 0,
        chats: 0,
        paidDms: 0,
        communities: 0,
      });
    });

    it('refuses bad queries with 400', async () => {
      await as(hana).get('/inbox?limit=0').expect(400);
      await as(hana).get('/inbox?limit=101').expect(400);
      await as(hana).get('/inbox?limit=abc').expect(400);
      await as(hana).get('/inbox?kind=money').expect(400);
      await as(hana).get('/inbox?nope=1').expect(400);
      await as(hana).get('/inbox?cursor=not-a-cursor').expect(400);
      const wrongKey = Buffer.from(
        `${new Date().toISOString()}|chat:not-a-uuid`,
        'utf8',
      ).toString('base64url');
      await as(hana).get(`/inbox?cursor=${wrongKey}`).expect(400);
    });
  });

  describe('the capability check', () => {
    let ifeChat: string;

    it('shows 3 for two unread chats and one unanswered paid question, and 2 after opening one chat', async () => {
      // Two people message Hana through the real chat routes.
      const first = data<{ id: string }>(
        await as(ife).post('/chats', { wawuId: hana.sub }).expect(200),
      );
      ifeChat = first.id;
      await as(ife)
        .post(`/chats/${ifeChat}/messages`, { text: 'Hello Hana' })
        .expect(201);
      const second = data<{ id: string }>(
        await as(jide).post('/chats', { wawuId: hana.sub }).expect(200),
      );
      await as(jide)
        .post(`/chats/${second.id}/messages`, { text: 'Hana, are you there?' })
        .expect(201);
      // A fan asks her a paid question, still inside its window.
      await dmRow({
        from: kemi.sub,
        to: hana.sub,
        at: new Date(),
        text: 'Can you design my logo?',
      });

      expect(await unread(hana)).toEqual({
        total: 3,
        chats: 2,
        paidDms: 1,
        communities: 0,
      });
      const list = await inbox(hana);
      expect(list.items.map((i) => [i.kind, i.unreadCount]).sort()).toEqual([
        ['chat', 1],
        ['chat', 1],
        ['paid_dm', 1],
      ]);
      const paid = list.items.find((i) => i.kind === 'paid_dm')!;
      expect(paid.paidDm).toMatchObject({
        side: 'creator',
        waitingCount: 1,
        questionCount: 1,
        other: { wawuId: kemi.sub, name: kemi.fullName },
      });
      expect(paid.preview).toMatchObject({
        text: 'Can you design my logo?',
        mine: false,
      });

      // Opening Ife's chat reads it.
      await as(hana).post(`/chats/${ifeChat}/read`, {}).expect(200);
      expect(await unread(hana)).toMatchObject({
        total: 2,
        chats: 1,
        paidDms: 1,
      });
      const after = await inbox(hana);
      expect(
        after.items.find((i) => i.id === `chat:${ifeChat}`)!.unreadCount,
      ).toBe(0);
    });

    it('drops the paid count once the creator answers', async () => {
      const row = await prisma.directMessage.findFirstOrThrow({
        where: { creatorWawuId: hana.sub },
      });
      await prisma.directMessage.update({
        where: { id: row.id },
        data: { status: 'responded', respondedAt: new Date() },
      });
      expect(await unread(hana)).toMatchObject({ total: 1, paidDms: 0 });
    });

    it('keeps one person to one inbox: another account sees none of it', async () => {
      expect(await inbox(efe)).toEqual({ items: [], nextCursor: null });
      expect((await unread(efe)).total).toBe(0);
    });
  });

  describe('each count equals its own source', () => {
    const T = Date.now() - 24 * HOUR;
    const at = (minutes: number) => new Date(T + minutes * 60_000);
    let ghostId: string;
    let ghostChat: string;
    let emptyChat: string;
    let c1: string;
    let c2: string;
    let rooms: Record<'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6', string>;
    let sourceChats: ChatSummaryPage;
    let sourceRooms: MyCommunity[];
    let fanThreads: PaidDmThreadPage;
    let creatorThreads: PaidDmThreadPage;
    let rows: InboxItem[];

    beforeAll(async () => {
      ghostId = ghost();
      // Bola sent three messages; Ada has read the first.
      const one = await chatRow(ada.sub, bola.sub, [
        { from: bola.sub, at: at(10) },
        { from: bola.sub, at: at(11) },
        { from: bola.sub, at: at(12), kind: 'image', text: '' },
      ]);
      c1 = one.id;
      await prisma.chatParticipant.update({
        where: {
          conversationId_wawuUserId: {
            conversationId: c1,
            wawuUserId: ada.sub,
          },
        },
        data: { lastReadAt: at(10), lastReadMessageId: one.messageIds[0] },
      });
      // Chidi sent two; Ada has read nothing; Ada blocked Chidi.
      c2 = (
        await chatRow(ada.sub, chidi.sub, [
          { from: chidi.sub, at: at(20) },
          { from: ada.sub, at: at(21), text: 'I replied' },
          { from: chidi.sub, at: at(22), text: 'Please answer' },
        ])
      ).id;
      await prisma.blockedAccount.create({
        data: { userWawuId: ada.sub, blockedWawuId: chidi.sub },
      });
      // A chat with an account that is gone (one message from them).
      ghostChat = (
        await chatRow(ada.sub, ghostId, [{ from: ghostId, at: at(30) }])
      ).id;
      // A chat opened and never written in.
      emptyChat = (await chatRow(ada.sub, ghost(), [])).id;

      rooms = {
        // Ada hosts. Bola wrote twice, Chidi (blocked) once, Ada once.
        r1: await roomRow({
          host: ada.sub,
          name: 'Spec Host Room',
          messages: [
            { sender: bola.sub, at: at(40) },
            { sender: chidi.sub, at: at(41) },
            { sender: ada.sub, at: at(42) },
            { sender: bola.sub, at: at(43) },
          ],
        }),
        // Ada joined at 50; one message before, two after; never opened.
        r2: await roomRow({
          host: bola.sub,
          name: 'Spec Member Room',
          members: [{ user: ada.sub, joinedAt: at(50) }],
          messages: [
            { sender: bola.sub, at: at(49) },
            { sender: bola.sub, at: at(51) },
            { sender: bola.sub, at: at(52) },
          ],
        }),
        // Ada opened it at 60; one message since.
        r3: await roomRow({
          host: bola.sub,
          name: 'Spec Read Room',
          members: [{ user: ada.sub, joinedAt: at(55) }],
          messages: [
            { sender: bola.sub, at: at(58) },
            { sender: bola.sub, at: at(61) },
          ],
          marker: { user: ada.sub, at: at(60) },
        }),
        // Ada asked and is still waiting.
        r4: await roomRow({
          host: bola.sub,
          name: 'Spec Pending Room',
          kind: 'private',
          members: [{ user: ada.sub, status: 'pending' }],
          messages: [{ sender: bola.sub, at: at(70) }],
        }),
        // Ada was removed (no membership row left).
        r5: await roomRow({
          host: bola.sub,
          name: 'Spec Removed Room',
          messages: [{ sender: bola.sub, at: at(71) }],
        }),
        // Ada hosts a room nobody has written in.
        r6: await roomRow({ host: ada.sub, name: 'Spec Empty Room' }),
      };

      // Paid questions. Bola asked Ada: two waiting, one answered with a
      // later reply, one refunded, one open but past its deadline.
      await dmRow({
        from: bola.sub,
        to: ada.sub,
        at: at(80),
        text: 'waiting one',
      });
      await dmRow({
        from: bola.sub,
        to: ada.sub,
        at: at(81),
        text: 'waiting two',
      });
      await dmRow({
        from: bola.sub,
        to: ada.sub,
        at: at(82),
        status: 'responded',
        text: 'answered',
        replies: [{ at: at(90), text: 'here is my answer' }],
      });
      await dmRow({
        from: bola.sub,
        to: ada.sub,
        at: at(83),
        status: 'refunded',
        text: 'refunded',
      });
      await dmRow({
        from: bola.sub,
        to: ada.sub,
        at: at(84),
        text: 'too late',
        deadlineAt: new Date(Date.now() - HOUR),
      });
      // Ada asked Bola one (waiting): the fan side, the same person.
      await dmRow({
        from: ada.sub,
        to: bola.sub,
        at: at(85),
        text: 'my question to Bola',
      });
      // Ada asked an account that is gone.
      await dmRow({
        from: ada.sub,
        to: ghostId,
        at: at(86),
        text: 'to a ghost',
      });

      sourceChats = data<ChatSummaryPage>(
        await as(ada).get('/chats?limit=100').expect(200),
      );
      sourceRooms = data<MyCommunity[]>(
        await as(ada).get('/communities/mine?perPage=100').expect(200),
      );
      fanThreads = data<PaidDmThreadPage>(
        await as(ada).get('/paid-dm/threads?as=fan&limit=100').expect(200),
      );
      creatorThreads = data<PaidDmThreadPage>(
        await as(ada).get('/paid-dm/threads?as=creator&limit=100').expect(200),
      );
      rows = await everyRow(ada, 100);
    });

    it('lists chats, rooms and paid threads, and leaves out what the sources leave out', () => {
      const ids = rows.map((r) => r.id);
      // Chats: three with messages; the empty chat is not a conversation yet.
      expect(ids).toEqual(
        expect.arrayContaining([
          `chat:${c1}`,
          `chat:${c2}`,
          `chat:${ghostChat}`,
        ]),
      );
      expect(ids).not.toContain(`chat:${emptyChat}`);
      // Rooms: hosted and joined; never a pending request or a removed member.
      expect(ids).toEqual(
        expect.arrayContaining([
          `community:${rooms.r1}`,
          `community:${rooms.r2}`,
          `community:${rooms.r3}`,
          `community:${rooms.r6}`,
        ]),
      );
      expect(ids).not.toContain(`community:${rooms.r4}`);
      expect(ids).not.toContain(`community:${rooms.r5}`);
      // Paid threads: one row per person and side.
      expect(ids).toEqual(
        expect.arrayContaining([
          `paid_dm:creator:${bola.sub}`,
          `paid_dm:fan:${bola.sub}`,
          `paid_dm:fan:${ghostId}`,
        ]),
      );
      expect(rows).toHaveLength(3 + 4 + 3);
    });

    it('chats: the same unread count, activity time and block state as GET /chats', () => {
      const mine = rows.filter((r) => r.kind === 'chat');
      expect(mine).toHaveLength(3);
      for (const row of mine) {
        const src = sourceChats.items.find((c) => c.id === row.chat!.chatId)!;
        expect(row.unreadCount).toBe(src.unreadCount);
        expect(row.lastActivityAt).toBe(src.lastActivityAt);
        expect(row.chat!.canMessage).toBe(src.canMessage);
        expect(row.chat!.other.wawuId).toBe(src.other.wawuId);
        expect(row.preview!.text).toBe(src.lastMessage!.text);
        expect(row.preview!.mine).toBe(src.lastMessage!.mine);
      }
      const byChat = (id: string) => rows.find((r) => r.id === `chat:${id}`)!;
      expect(byChat(c1).unreadCount).toBe(2);
      expect(byChat(c1).preview).toMatchObject({
        attachment: 'image',
        mine: false,
      });
      // A blocked chat still shows, as GET /chats shows it, with the composer off.
      expect(byChat(c2).unreadCount).toBe(2);
      expect(byChat(c2).chat!.canMessage).toBe(false);
      // A deleted account shows with no name, as GET /chats shows it.
      expect(byChat(ghostChat).chat!.other).toMatchObject({
        wawuId: ghostId,
        name: '',
      });
      expect(byChat(ghostChat).unreadCount).toBe(1);
    });

    it('rooms: the same unread count, activity time and role as GET /communities/mine', () => {
      const mine = rows.filter((r) => r.kind === 'community');
      expect(mine).toHaveLength(sourceRooms.length);
      for (const row of mine) {
        const src = sourceRooms.find(
          (c) => c.id === row.community!.communityId,
        )!;
        expect(row.unreadCount).toBe(src.unreadCount);
        expect(row.community!.role).toBe(src.role);
        expect(row.community!.name).toBe(src.name);
        expect(row.lastActivityAt).toBe(
          src.lastActivityAt
            ? new Date(src.lastActivityAt).toISOString()
            : null,
        );
        expect(row.preview?.text ?? null).toBe(src.lastMessage?.text ?? null);
      }
      const byRoom = (id: string) =>
        rows.find((r) => r.id === `community:${id}`)!;
      // Bola wrote twice; Chidi (blocked) and Ada herself do not count.
      expect(byRoom(rooms.r1).unreadCount).toBe(2);
      expect(byRoom(rooms.r1).community!.role).toBe('host');
      // The blocked sender's message is not the preview either.
      expect(byRoom(rooms.r1).preview).toMatchObject({ mine: false });
      // Messages after joining only.
      expect(byRoom(rooms.r2).unreadCount).toBe(2);
      // Messages after the read marker only.
      expect(byRoom(rooms.r3).unreadCount).toBe(1);
      // A host's empty room has no activity time and ranks last.
      expect(byRoom(rooms.r6).lastActivityAt).toBeNull();
      expect(byRoom(rooms.r6).preview).toBeNull();
      expect(byRoom(rooms.r6).unreadCount).toBe(0);
    });

    it('paid threads: waiting questions are what the creator side counts, the fan side counts none', () => {
      const asCreator = creatorThreads.items.find(
        (t) => t.other.wawuId === bola.sub,
      )!;
      const asFan = fanThreads.items.find((t) => t.other.wawuId === bola.sub)!;
      const creatorRow = rows.find(
        (r) => r.id === `paid_dm:creator:${bola.sub}`,
      )!;
      const fanRow = rows.find((r) => r.id === `paid_dm:fan:${bola.sub}`)!;
      expect(asCreator.waitingCount).toBe(2);
      expect(creatorRow.unreadCount).toBe(asCreator.waitingCount);
      expect(creatorRow.paidDm).toMatchObject({
        side: 'creator',
        questionCount: asCreator.questionCount,
        waitingCount: asCreator.waitingCount,
        nextDeadlineAt: asCreator.nextDeadlineAt,
      });
      expect(creatorRow.lastActivityAt).toBe(asCreator.lastActivityAt);
      // The newest bubble is the creator's reply: written by Ada.
      expect(creatorRow.preview).toMatchObject({
        text: asCreator.lastText,
        mine: asCreator.lastTextMine,
      });
      expect(creatorRow.preview!.mine).toBe(true);
      // The thread Ada started with Bola is hers: nothing is unread in it.
      expect(asFan.waitingCount).toBe(1);
      expect(fanRow.unreadCount).toBe(0);
      expect(fanRow.paidDm).toMatchObject({ side: 'fan', waitingCount: 1 });
      expect(fanRow.preview).toMatchObject({
        text: asFan.lastText,
        mine: true,
      });
    });

    it('is ordered by latest activity, then key, both newest first', () => {
      expect(rows.map((r) => r.id)).toEqual(sorted(rows).map((r) => r.id));
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    });

    it('the badge is the sum of every row, and its parts add up', async () => {
      const total = rows.reduce((n, r) => n + r.unreadCount, 0);
      const badge = await unread(ada);
      expect(badge.total).toBe(total);
      expect(badge.chats + badge.paidDms + badge.communities).toBe(badge.total);
      const sum = (kind: string) =>
        rows
          .filter((r) => r.kind === kind)
          .reduce((n, r) => n + r.unreadCount, 0);
      expect(badge).toEqual({
        total,
        chats: sum('chat'),
        paidDms: sum('paid_dm'),
        communities: sum('community'),
      });
      // And the same when the list is read one row at a time.
      const oneByOne = await everyRow(ada, 1);
      expect(oneByOne.reduce((n, r) => n + r.unreadCount, 0)).toBe(badge.total);
    });

    it('opening a chat or a room lowers the badge by exactly what the row showed', async () => {
      const before = (await unread(ada)).total;
      await as(ada).post(`/chats/${c1}/read`, {}).expect(200);
      expect((await unread(ada)).total).toBe(before - 2);
      await as(ada).post(`/communities/${rooms.r2}/read`, {}).expect(200);
      expect((await unread(ada)).total).toBe(before - 4);
      const row = (await inbox(ada, '?kind=community')).items.find(
        (i) => i.id === `community:${rooms.r2}`,
      )!;
      expect(row.unreadCount).toBe(0);
    });

    it('lets the chips filter by kind, and pages inside a kind', async () => {
      for (const kind of ['chat', 'paid_dm', 'community'] as const) {
        const only = await everyRow(ada, 2, kind);
        expect(only.length).toBeGreaterThan(0);
        expect(only.every((r) => r.kind === kind)).toBe(true);
        expect(only.map((r) => r.id)).toEqual(
          sorted(rows.filter((r) => r.kind === kind)).map((r) => r.id),
        );
      }
    });

    it('a block taken away brings the blocked sender back into the count', async () => {
      const room = (items: InboxItem[]) =>
        items.find((i) => i.id === `community:${rooms.r1}`)!;
      expect(room((await inbox(ada)).items).unreadCount).toBe(2);
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: ada.sub, blockedWawuId: chidi.sub },
      });
      const unblocked = room((await inbox(ada)).items);
      const src = data<MyCommunity[]>(
        await as(ada).get('/communities/mine?perPage=100').expect(200),
      ).find((c) => c.id === rooms.r1)!;
      expect(unblocked.unreadCount).toBe(3);
      expect(unblocked.unreadCount).toBe(src.unreadCount);
      const chat = (await inbox(ada)).items.find((i) => i.id === `chat:${c2}`)!;
      expect(chat.chat!.canMessage).toBe(true);
    });
  });

  describe('one order across three sources', () => {
    const base = Date.now() - 6 * HOUR;
    let expected: InboxItem[];
    let rowsAfter: InboxItem[];

    async function seedEfe() {
      // Nine rows share one instant, three of each kind; four others sit
      // around it. Identical times are what make a page boundary hard.
      const tie = new Date(base);
      for (let i = 0; i < 3; i += 1) {
        await chatRow(efe.sub, ghost(), [
          { from: ghost(), at: tie, text: `tie chat ${i}` },
        ]);
        await roomRow({
          host: efe.sub,
          name: `Tie Room ${i}`,
          messages: [{ sender: ghost(), at: tie }],
        });
        await dmRow({
          from: ghost(),
          to: efe.sub,
          at: tie,
          text: `tie question ${i}`,
        });
      }
      await chatRow(efe.sub, ghost(), [
        { from: efe.sub, at: new Date(base + 5 * 60_000) },
      ]);
      await chatRow(efe.sub, ghost(), [
        { from: ghost(), at: new Date(base - 5 * 60_000) },
      ]);
      await roomRow({
        host: efe.sub,
        name: 'Newest Room',
        messages: [{ sender: ghost(), at: new Date(base + 9 * 60_000) }],
      });
      await roomRow({ host: efe.sub, name: 'Silent Room' });
    }

    beforeAll(async () => {
      await seedEfe();
      expected = sorted(await everyRow(efe, 100));
    });

    it('holds 13 rows with nine tied, in one fixed order', () => {
      expect(expected).toHaveLength(13);
      const tied = expected.filter(
        (r) => r.lastActivityAt === new Date(base).toISOString(),
      );
      expect(tied).toHaveLength(9);
      expect(new Set(expected.map((r) => r.kind))).toEqual(
        new Set(['chat', 'community', 'paid_dm']),
      );
    });

    it.each([1, 2, 3, 4, 5, 7, 12, 13, 100])(
      'pages of %i rows join up with no loss and no repeat',
      async (size) => {
        const got = await everyRow(efe, size);
        expect(got.map((r) => r.id)).toEqual(expected.map((r) => r.id));
      },
    );

    it('keeps the order and loses nothing when rows arrive between pages', async () => {
      const first = await inbox(efe, '?limit=4');
      expect(first.nextCursor).not.toBeNull();
      const seen = first.items.map((r) => r.id);

      // While the person reads, a message lands in a chat further down the
      // list (it jumps to the top), a brand new chat opens, and a new
      // question arrives.
      const tail = expected.slice(4).find((r) => r.kind === 'chat')!;
      await prisma.chatMessage.create({
        data: {
          conversationId: tail.chat!.chatId,
          senderWawuId: tail.chat!.other.wawuId,
          kind: 'text',
          text: 'a new message',
        },
      });
      await prisma.chatConversation.update({
        where: { id: tail.chat!.chatId },
        data: { lastActivityAt: new Date() },
      });
      const fresh = await chatRow(efe.sub, ghost(), [
        { from: ghost(), at: new Date() },
      ]);
      await dmRow({ from: ghost(), to: efe.sub, at: new Date() });

      const rest: string[] = [];
      let cursor: string | null = first.nextCursor;
      while (cursor) {
        const page: InboxPage = await inbox(efe, `?limit=3&cursor=${cursor}`);
        rest.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      }
      // No row twice across the pages read so far.
      expect(new Set([...seen, ...rest]).size).toBe(seen.length + rest.length);
      // Everything that was below the cursor and did not move is still
      // delivered, in the same order. The one that moved up is not repeated
      // and not below the cursor any more.
      const below = expected
        .slice(4)
        .map((r) => r.id)
        .filter((id) => id !== tail.id);
      expect(rest).toEqual(below);

      // A fresh read from the top holds all of it, the moved and the new on top.
      rowsAfter = await everyRow(efe, 100);
      const top = rowsAfter.slice(0, 3).map((r) => r.id);
      expect(top).toEqual(
        expect.arrayContaining([tail.id, `chat:${fresh.id}`]),
      );
      expect(top.filter((id) => id.startsWith('paid_dm'))).toHaveLength(1);
      expect(rowsAfter.map((r) => r.id)).toEqual(
        sorted(rowsAfter).map((r) => r.id),
      );
      expect(rowsAfter).toHaveLength(13 + 2);
    });

    it('a cursor from one filter carries on in the same order under the full list', async () => {
      const page = await inbox(efe, '?limit=3&kind=community');
      const next = await inbox(efe, `?limit=100&cursor=${page.nextCursor}`);
      const key = page.items[page.items.length - 1];
      for (const row of next.items) {
        const later =
          Date.parse(row.lastActivityAt ?? '1970-01-01T00:00:00.000Z') <
            Date.parse(key.lastActivityAt!) ||
          (row.lastActivityAt === key.lastActivityAt && row.id < key.id);
        expect(later).toBe(true);
      }
    });
  });

  describe('a fixed number of queries, whatever the page size', () => {
    it('reads a page of 3 rows and a page of 40 with the same queries', async () => {
      const pg = prisma as unknown as {
        $queryRaw: (...a: unknown[]) => unknown;
        community: { findMany: (...a: unknown[]) => unknown };
        chatConversation: { findMany: (...a: unknown[]) => unknown };
        userProfile: { findMany: (...a: unknown[]) => unknown };
        blockedAccount: { findMany: (...a: unknown[]) => unknown };
      };
      const spies = [
        jest.spyOn(pg, '$queryRaw'),
        jest.spyOn(pg.community, 'findMany'),
        jest.spyOn(pg.chatConversation, 'findMany'),
        jest.spyOn(pg.userProfile, 'findMany'),
        jest.spyOn(pg.blockedAccount, 'findMany'),
      ];
      const identities = jest.spyOn(
        moduleRef.get(WawuIdClient, { strict: false }),
        'lookupPublicIdentities',
      );
      const count = () =>
        [...spies, identities].reduce((n, s) => n + s.mock.calls.length, 0);

      await wide.seed();
      const small = await inbox(wide.owner, '?limit=3');
      expect(small.items).toHaveLength(3);
      const smallCalls = count();
      spies.forEach((s) => s.mockClear());
      identities.mockClear();
      const big = await inbox(wide.owner, '?limit=40');
      expect(big.items).toHaveLength(40);
      const bigCalls = count();
      expect(bigCalls).toBe(smallCalls);
      expect(bigCalls).toBeLessThan(16);
      spies.forEach((s) => s.mockRestore());
      identities.mockRestore();
    });
  });

  // The 40-row person for the query-count check, kept out of the others'
  // data so no earlier test sees it.
  const wide = {
    get owner(): Person {
      return dayo;
    },
    async seed() {
      // Dayo has no Hub profile, like most people who never wrote one.
      for (let i = 0; i < 14; i += 1) {
        await chatRow(dayo.sub, ghost(), [
          { from: ghost(), at: new Date(Date.now() - i * 1000) },
        ]);
        await roomRow({
          host: dayo.sub,
          name: `Wide Room ${i}`,
          messages: [{ sender: ghost(), at: new Date(Date.now() - i * 1000) }],
        });
        await dmRow({
          from: ghost(),
          to: dayo.sub,
          at: new Date(Date.now() - i * 1000),
        });
      }
    },
  };
});
