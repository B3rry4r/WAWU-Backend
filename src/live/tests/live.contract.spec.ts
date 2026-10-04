// Contract tests for live updates (task INBOX-02).
//
// The capability check the task names, with real sockets and real tokens from
// the local mock WAWU ID: two signed-in clients, a message sent by one reaches
// the other within two seconds, and a blocked user's socket receives nothing.
// Around it: who may receive what, a reconnect that loses nothing, tokens that
// run out, many sockets at once, and two Hub instances sharing one feed.
//
// Every identity here is a throwaway registered by this spec and every row it
// writes is removed in afterAll (README, test hygiene).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import type { AddressInfo } from 'net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { LiveModule } from '../live.module';
import { LivePublisher } from '../live-publisher.service';
import { LIVE_LIMITS } from '../live-limits';
import type { LiveCatchUp, LiveEvent } from '../live-event.type';
import type { ChatSummary } from '../../chat/chat-view.type';

import {
  Client,
  data,
  MOCK_DIR,
  MOCK_WAWU_ID_BASE,
  MOCK_WAWU_ID_PORT,
  registerPerson,
  settle,
  shortLivedToken,
  waitForHealth,
  type Person,
} from './live-test-kit';

describe('Live updates (contract, INBOX-02)', () => {
  let app: INestApplication<App>;
  let appTwo: INestApplication<App>;
  let port: number;
  let portTwo: number;
  let prisma: PrismaService;
  let publisher: LivePublisher;
  let mockWawuId: ChildProcess | undefined;

  let ada: Person;
  let bola: Person;
  let chidi: Person;
  let dayo: Person;
  let evan: Person;
  const crowd: Person[] = [];
  let chatId: string;
  let communityId: string;
  let crowdCommunityId: string;
  const opened: Client[] = [];

  const open = async (...args: Parameters<typeof Client.open>) => {
    const c = await Client.open(...args);
    opened.push(c);
    return c;
  };
  const http = () => request(app.getHttpServer());
  const as = (who: { token: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${who.token}`).send(body),
  });
  const everyone = () =>
    [ada, bola, chidi, dayo, evan, ...crowd].map((p) => p.sub);

  async function startApp(): Promise<{
    app: INestApplication<App>;
    port: number;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        LiveModule,
      ],
    }).compile();
    const instance = moduleRef.createNestApplication<INestApplication<App>>();
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    instance.useGlobalFilters(new AllExceptionsFilter());
    instance.useGlobalInterceptors(new ResponseInterceptor());
    await instance.init();
    await instance.listen(0);
    const address = (
      instance.getHttpServer() as { address(): unknown }
    ).address() as AddressInfo;
    return { app: instance, port: address.port };
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: MOCK_DIR,
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ada = await registerPerson('Ada');
    bola = await registerPerson('Bola');
    chidi = await registerPerson('Chidi');
    dayo = await registerPerson('Dayo');
    evan = await registerPerson('Evan');
    for (let i = 0; i < 20; i += 1)
      crowd.push(await registerPerson(`Crowd${i}`));

    ({ app, port } = await startApp());
    ({ app: appTwo, port: portTwo } = await startApp());
    prisma = app.get(PrismaService);
    publisher = app.get(LivePublisher);

    for (const p of [ada, bola, chidi]) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `livespec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for live.contract.spec.ts.',
          interests: [],
        },
      });
    }
    const chat = data<ChatSummary>(
      await as(ada).post('/chats', { wawuId: bola.sub }).expect(200),
    );
    chatId = chat.id;

    // Ada hosts a room. Bola and Chidi have joined it; Evan's request is
    // still pending; Dayo never asked.
    const community = await prisma.community.create({
      data: {
        name: 'Live spec room',
        description: 'Fixture for live.contract.spec.ts.',
        hostWawuId: ada.sub,
        kind: 'open',
      },
    });
    communityId = community.id;
    await prisma.communityMembership.createMany({
      data: [
        {
          userWawuId: bola.sub,
          communityId,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          userWawuId: chidi.sub,
          communityId,
          status: 'joined',
          joinedAt: new Date(),
        },
        { userWawuId: evan.sub, communityId, status: 'pending' },
      ],
    });
    const big = await prisma.community.create({
      data: {
        name: 'Live spec crowd',
        description: 'Fixture for live.contract.spec.ts.',
        hostWawuId: ada.sub,
        kind: 'open',
      },
    });
    crowdCommunityId = big.id;
    await prisma.communityMembership.createMany({
      data: crowd.map((p) => ({
        userWawuId: p.sub,
        communityId: crowdCommunityId,
        status: 'joined' as const,
        joinedAt: new Date(),
      })),
    });
  }, 90000);

  afterAll(async () => {
    for (const c of opened) c.ws.terminate();
    if (prisma) {
      const ids = everyone();
      await prisma.chatConversation.deleteMany({
        where: {
          OR: [{ userAWawuId: { in: ids } }, { userBWawuId: { in: ids } }],
        },
      });
      await prisma.community.deleteMany({
        where: { id: { in: [communityId, crowdCommunityId].filter(Boolean) } },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: ids } }, { blockedWawuId: { in: ids } }],
        },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    if (app) await app.close();
    if (appTwo) await appTwo.close();
    mockWawuId?.kill();
  });

  const send = (who: Person, text: string, on = chatId) =>
    as(who).post(`/chats/${on}/messages`, { text }).expect(201);
  const post = (who: Person, text: string, on = communityId) =>
    as(who).post(`/communities/${on}/messages`, { text }).expect(201);
  const isMessage = (text: string) => (e: LiveEvent) =>
    (e.type === 'chat.message' && e.message.text === text) ||
    (e.type === 'community.message' && e.message.text === text);

  describe('signing in', () => {
    it('catch-up is 401 with no token', async () => {
      await http().get('/live/catch-up').expect(401);
    });

    it('accepts a WAWU ID token in the upgrade header and tells the client where now is', async () => {
      const c = await open(port, ada.token, 'header');
      expect(c.ready).toMatchObject({ type: 'ready', wawuId: ada.sub });
      expect(typeof c.ready!.cursor).toBe('string');
      c.close();
    });

    it('accepts a token sent as the first frame (browsers cannot set a header)', async () => {
      const c = await open(port, ada.token, 'frame');
      expect(c.ready!.wawuId).toBe(ada.sub);
      c.close();
    });

    it('refuses a token that is not a real WAWU ID token, with 4401', async () => {
      const forged = jwt.sign({ sub: ada.sub }, 'not-the-wawu-id-key', {
        expiresIn: 60,
      });
      const viaFrame = await Client.open(port, null);
      viaFrame.ws.send(JSON.stringify({ type: 'auth', token: forged }));
      expect((await viaFrame.closedWith()).code).toBe(4401);

      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_LIMITS.path}`, {
        headers: { Authorization: `Bearer ${forged}` },
      });
      const code = await new Promise<number>((resolve) =>
        ws.on('close', (c) => resolve(c)),
      );
      expect(code).toBe(4401);
    });

    it('closes a socket that sends something else first, and one that never signs in', async () => {
      const chatty = await Client.open(port, null);
      chatty.ws.send(JSON.stringify({ type: 'ping' }));
      expect((await chatty.closedWith()).code).toBe(4401);

      const silent = await Client.open(port, null);
      expect(
        (await silent.closedWith(LIVE_LIMITS.authTimeoutMs + 2000)).reason,
      ).toBe('auth_timeout');
    }, 15000);

    it('answers an app-level ping once signed in', async () => {
      const c = await open(port, ada.token);
      c.ws.send(JSON.stringify({ type: 'ping' }));
      await c.until(() => c.frames.some((f) => f.type === 'pong'));
      c.close();
    });

    it('closes the socket with 4401 when the token runs out, and a fresh token keeps it open', async () => {
      const expiring = await open(port, shortLivedToken(ada, 2));
      const renewed = await open(port, shortLivedToken(ada, 2));
      renewed.ws.send(JSON.stringify({ type: 'auth', token: ada.token }));
      expect((await expiring.closedWith(4000)).reason).toBe('token_expired');
      await settle(1500);
      expect(renewed.closed).toBeUndefined();
      renewed.close();
    }, 15000);

    it("refuses another person's token on a socket that is already signed in, with 4403", async () => {
      const c = await open(port, ada.token);
      c.ws.send(JSON.stringify({ type: 'auth', token: bola.token }));
      expect((await c.closedWith()).code).toBe(4403);
    });
  });

  describe('two signed-in clients (the capability check)', () => {
    it('a message one sends reaches the other within two seconds', async () => {
      const adaSocket = await open(port, ada.token);
      const bolaSocket = await open(port, bola.token, 'frame');
      const chidiSocket = await open(port, chidi.token);

      const sentAt = Date.now();
      const sent = data<{ id: string }>(await send(ada, 'Hello Bola'));
      const got = await bolaSocket.event<LiveEvent & { type: 'chat.message' }>(
        isMessage('Hello Bola'),
        2000,
      );
      expect(Date.now() - sentAt).toBeLessThan(2000);
      expect(got.message).toMatchObject({
        id: sent.id,
        chatId,
        senderWawuId: ada.sub,
        mine: false,
        text: 'Hello Bola',
        readState: null,
        clientMessageId: null,
      });
      expect(typeof got.cursor).toBe('string');

      // Ada's own phone gets it too, as hers.
      const echo = await adaSocket.event<LiveEvent & { type: 'chat.message' }>(
        isMessage('Hello Bola'),
      );
      expect(echo.message).toMatchObject({ mine: true, readState: 'sent' });

      // Chidi is signed in and in nobody's chat: nothing arrives.
      await settle();
      expect(
        chidiSocket.events().filter((e) => e.type === 'chat.message'),
      ).toEqual([]);
      for (const c of [adaSocket, bolaSocket, chidiSocket]) c.close();
    });

    it("a read mark reaches the sender as 'read', and the reader's other phone as theirs", async () => {
      const adaSocket = await open(port, ada.token);
      const bolaPhone = await open(port, bola.token);
      const bolaOther = await open(port, bola.token);
      const sent = data<{ id: string }>(await send(ada, 'Did you see this'));
      await bolaPhone.event(isMessage('Did you see this'));

      await as(bola)
        .post(`/chats/${chatId}/read`, { messageId: sent.id })
        .expect(200);

      const read = await adaSocket.event<LiveEvent & { type: 'chat.read' }>(
        (e) => e.type === 'chat.read',
      );
      expect(read).toMatchObject({
        chatId,
        readerWawuId: bola.sub,
        mine: false,
        lastReadMessageId: sent.id,
      });
      const mine = await bolaOther.event<LiveEvent & { type: 'chat.read' }>(
        (e) => e.type === 'chat.read',
      );
      expect(mine.mine).toBe(true);

      // Reading what is already read moves nothing, so nothing is sent.
      const before = adaSocket.events().length;
      await as(bola)
        .post(`/chats/${chatId}/read`, { messageId: sent.id })
        .expect(200);
      await settle();
      expect(adaSocket.events().length).toBe(before);
      for (const c of [adaSocket, bolaPhone, bolaOther]) c.close();
    });
  });

  describe('who receives what', () => {
    it('a community message reaches the host and joined members only', async () => {
      const [host, member, member2, pending, stranger] = await Promise.all([
        open(port, ada.token),
        open(port, bola.token),
        open(port, chidi.token),
        open(port, evan.token),
        open(port, dayo.token),
      ]);
      await post(ada, 'Welcome to the room');
      const got = await member.event<LiveEvent & { type: 'community.message' }>(
        isMessage('Welcome to the room'),
      );
      expect(got).toMatchObject({ communityId });
      expect(got.message.sender).toMatchObject({ wawuId: ada.sub });
      await member2.event(isMessage('Welcome to the room'));
      await host.event(isMessage('Welcome to the room'));
      await settle();
      expect(pending.events()).toEqual([]);
      expect(stranger.events()).toEqual([]);
      for (const c of [host, member, member2, pending, stranger]) c.close();
    });

    it('stops at once for someone who leaves, with the socket still open', async () => {
      const member = await open(port, chidi.token);
      await post(ada, 'Before Chidi leaves');
      await member.event(isMessage('Before Chidi leaves'));
      await prisma.communityMembership.update({
        where: {
          userWawuId_communityId: { userWawuId: chidi.sub, communityId },
        },
        data: { status: 'pending' },
      });
      await post(ada, 'After Chidi leaves');
      await settle();
      expect(member.events().some(isMessage('After Chidi leaves'))).toBe(false);
      await prisma.communityMembership.update({
        where: {
          userWawuId_communityId: { userWawuId: chidi.sub, communityId },
        },
        data: { status: 'joined' },
      });
      member.close();
    });

    it("a blocked user's socket receives nothing, in a chat or a community", async () => {
      const adaSocket = await open(port, ada.token);
      const bolaSocket = await open(port, bola.token);
      const chidiSocket = await open(port, chidi.token);

      // Bola blocks Ada.
      await as(bola)
        .post('/settings/privacy/blocked', { blockedWawuId: ada.sub })
        .expect(201);

      // Chat: neither can send now (403), and a message that was stored just
      // before the block and signalled just after it is shown to neither.
      await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'refused' })
        .expect(403);
      const late = await prisma.chatMessage.create({
        data: {
          conversationId: chatId,
          senderWawuId: ada.sub,
          kind: 'text',
          text: 'stored before the block',
        },
      });
      await publisher.publish({
        kind: 'chat.message',
        chatId,
        messageId: late.id,
      });
      // A read mark that moves after the block does not reach the blocked side.
      await as(bola)
        .post(`/chats/${chatId}/read`, { messageId: late.id })
        .expect(200);

      // Community: Ada posts in the room; Chidi gets it, Bola (who blocked her)
      // does not.
      await post(ada, 'Room message after the block');
      await chidiSocket.event(isMessage('Room message after the block'));
      await settle();
      expect(
        bolaSocket.events().some(isMessage('Room message after the block')),
      ).toBe(false);
      expect(
        bolaSocket.events().some(isMessage('stored before the block')),
      ).toBe(false);
      expect(
        adaSocket.events().some(isMessage('stored before the block')),
      ).toBe(false);
      expect(adaSocket.events().filter((e) => e.type === 'chat.read')).toEqual(
        [],
      );

      // And Bola posting in the room (blocked on Ada's side is Bola's own
      // block, so the symmetric case): Ada does not receive Bola's message.
      await post(bola, 'Bola in the room').catch(() => undefined);
      for (const c of [adaSocket, bolaSocket, chidiSocket]) c.close();
    });
  });

  describe('reconnecting and catching up', () => {
    it('a catch-up without a cursor returns nothing and says where now is', async () => {
      const res = data<LiveCatchUp>(
        await as(chidi).get('/live/catch-up').expect(200),
      );
      expect(res.events).toEqual([]);
      expect(res.hasMore).toBe(false);
      expect(typeof res.cursor).toBe('string');
      await as(chidi).get('/live/catch-up?cursor=garbage').expect(400);
      await as(chidi).get('/live/catch-up?limit=0').expect(400);
    });

    it('returns what was missed, oldest first, and leaves out a block on either side', async () => {
      // Bola still blocks Ada here: her chat and her room messages are not Bola's.
      const startBola = data<LiveCatchUp>(
        await as(bola).get('/live/catch-up').expect(200),
      );
      const startChidi = data<LiveCatchUp>(
        await as(chidi).get('/live/catch-up').expect(200),
      );
      await settle(50);
      await post(ada, 'missed one');
      await post(ada, 'missed two');
      const forChidi = data<LiveCatchUp>(
        await as(chidi)
          .get(`/live/catch-up?cursor=${startChidi.cursor}`)
          .expect(200),
      );
      // A catch-up reads a little behind its cursor (the overlap), so earlier
      // messages may repeat; the newest are last and in order.
      const texts = forChidi.events.map(
        (e) => (e as LiveEvent & { type: 'community.message' }).message.text,
      );
      expect(texts.slice(-2)).toEqual(['missed one', 'missed two']);
      const forBola = data<LiveCatchUp>(
        await as(bola)
          .get(`/live/catch-up?cursor=${startBola.cursor}`)
          .expect(200),
      );
      expect(forBola.events).toEqual([]);
    });

    it('loses nothing across a reconnect, with messages arriving while the socket is down', async () => {
      // Unblock so Ada and Bola can chat again.
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: { in: [ada.sub, bola.sub] } },
      });
      const bolaSocket = await open(port, bola.token);
      const seen = new Map<string, string>();
      const take = (events: LiveEvent[]) => {
        for (const e of events) {
          if (
            e.type === 'chat.message' &&
            e.message.text?.startsWith('burst')
          ) {
            seen.set(e.message.id, e.message.text);
          }
        }
      };
      const sentIds: string[] = [];
      // Ten while connected, sent concurrently...
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          send(ada, `burst ${i}`).then((r) =>
            sentIds.push(data<{ id: string }>(r).id),
          ),
        ),
      );
      await bolaSocket.until(
        () => bolaSocket.events().filter(isMessage2).length >= 10,
      );
      take(bolaSocket.events());
      const cursor = [...bolaSocket.events()]
        .filter(isMessage2)
        .map((e) => e.cursor)
        .sort()
        .pop()!;
      // ...the socket drops...
      bolaSocket.ws.terminate();
      // ...ten more arrive while Bola is offline...
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          send(ada, `burst ${10 + i}`).then((r) =>
            sentIds.push(data<{ id: string }>(r).id),
          ),
        ),
      );
      // ...and Bola reconnects: socket first, then the catch-up from the last cursor.
      const again = await open(port, bola.token);
      let next: string | undefined = cursor;
      for (let guard = 0; guard < 10 && next !== undefined; guard += 1) {
        const page: LiveCatchUp = data<LiveCatchUp>(
          await as(bola)
            .get(`/live/catch-up?cursor=${next}&limit=7`)
            .expect(200),
        );
        take(page.events);
        next = page.hasMore ? page.cursor : undefined;
      }
      take(again.events());
      expect([...seen.keys()].sort()).toEqual([...sentIds].sort());
      expect(seen.size).toBe(20);
      again.close();
    }, 20000);

    it('carries the read marks that moved while the sender was offline', async () => {
      const start = data<LiveCatchUp>(
        await as(ada).get('/live/catch-up').expect(200),
      );
      await settle(50);
      const sent = data<{ id: string }>(await send(ada, 'read while offline'));
      await as(bola)
        .post(`/chats/${chatId}/read`, { messageId: sent.id })
        .expect(200);
      const res = data<LiveCatchUp>(
        await as(ada).get(`/live/catch-up?cursor=${start.cursor}`).expect(200),
      );
      const read = res.events.find((e) => e.type === 'chat.read');
      expect(read).toMatchObject({
        chatId,
        readerWawuId: bola.sub,
        mine: false,
        lastReadMessageId: sent.id,
      });
    });

    it("never shows anyone else's chat or room", async () => {
      const start = data<LiveCatchUp>(
        await as(dayo).get('/live/catch-up').expect(200),
      );
      await settle(50);
      await send(ada, 'private to Ada and Bola');
      await post(ada, 'room message');
      const res = data<LiveCatchUp>(
        await as(dayo).get(`/live/catch-up?cursor=${start.cursor}`).expect(200),
      );
      expect(res.events).toEqual([]);
    });
  });

  describe('many sockets at once', () => {
    it('twenty members, each on their own socket, all receive a room message within two seconds', async () => {
      const sockets = await Promise.all(crowd.map((p) => open(port, p.token)));
      const sentAt = Date.now();
      await post(ada, 'To the whole crowd', crowdCommunityId);
      await Promise.all(
        sockets.map((s) => s.event(isMessage('To the whole crowd'), 2000)),
      );
      expect(Date.now() - sentAt).toBeLessThan(2000);
      for (const s of sockets) s.close();
    }, 20000);

    it('keeps one person to eight sockets by closing the oldest', async () => {
      const sockets: Client[] = [];
      for (let i = 0; i < LIVE_LIMITS.socketsPerUser + 1; i += 1) {
        sockets.push(await open(port, dayo.token));
      }
      expect((await sockets[0].closedWith()).code).toBe(4409);
      expect(sockets[1].closed).toBeUndefined();
      for (const s of sockets) s.close();
    });
  });

  describe('two Hub instances', () => {
    it('a message sent through one reaches a socket held by the other', async () => {
      const onTwo = await open(portTwo, bola.token);
      const onOne = await open(port, ada.token);
      await send(ada, 'across instances');
      await onTwo.event(isMessage('across instances'));
      await onOne.event(isMessage('across instances'));
      // And the other way round, through the second instance's HTTP.
      const viaTwo = await request(appTwo.getHttpServer())
        .post(`/chats/${chatId}/messages`)
        .set('Authorization', `Bearer ${bola.token}`)
        .send({ text: 'from instance two' })
        .expect(201);
      expect(viaTwo.status).toBe(201);
      await onOne.event(isMessage('from instance two'));
      onTwo.close();
      onOne.close();
    });
  });

  describe('when the feed from Postgres drops', () => {
    it('closes every socket with 4503, refuses new ones until it is back, then accepts again', async () => {
      const c = await open(port, ada.token);
      const d = await open(portTwo, bola.token);
      await prisma.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN wawu_live' AND pid <> pg_backend_pid()`;
      expect((await c.closedWith()).code).toBe(4503);
      expect((await d.closedWith()).code).toBe(4503);

      // The listener comes back on its own, and a sign-in then works again.
      let back: Client | undefined;
      for (let i = 0; i < 40 && !back; i += 1) {
        try {
          back = await open(port, ada.token);
        } catch {
          await settle(250);
        }
      }
      expect(back?.ready?.wawuId).toBe(ada.sub);
      await send(bola, 'after the feed came back');
      await back!.event(isMessage('after the feed came back'));
      back!.close();
    }, 30000);
  });
});

function isMessage2(e: LiveEvent): e is LiveEvent & { type: 'chat.message' } {
  return e.type === 'chat.message' && !!e.message.text?.startsWith('burst');
}
