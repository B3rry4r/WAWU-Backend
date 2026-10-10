import { randomUUID } from 'crypto';
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
import { LivePublisher } from '../../live/live-publisher.service';
import { CommunityMessageModule } from '../community-message.module';

/**
 * INBOX-05 round 5 (verifier defect 21): a community message is stored and
 * charged ONCE per sender and `Idempotency-Key`, a repeat answers with the
 * first message, and two requests with one key arriving at once (even on two
 * servers) still store and charge once.
 *
 * Owns its fixtures: two rooms under fixed ids, the seeded plain user as a
 * member and the seeded pro creator as the host. USER_PLAIN's CreditsState
 * row is snapshotted and restored (README, "Test hygiene rules").
 */
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const HOST = '00000000-0000-4000-8000-000000000003';

const ROOM = '20000000-0000-4000-8000-00000000a051';
const OTHER_ROOM = '20000000-0000-4000-8000-00000000a052';

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

type Answer = { data: { id: string; costInCredits: number }; reason?: string };
/** The body of an answer, typed: supertest hands it back as `any`. */
const bodyOf = (res: request.Response): Answer => res.body as Answer;

type CreditsStateRow = {
  userWawuId: string;
  creditBalance: number;
  trialEndsAt: Date | null;
} | null;

async function boot(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
  live: LivePublisher;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      CommunityMessageModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
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
  return {
    app,
    prisma: moduleRef.get(PrismaService),
    live: moduleRef.get(LivePublisher),
  };
}

describe('CommunityMessage Idempotency-Key (contract)', () => {
  let app: INestApplication;
  // A second, separate Nest application on the same database: its own
  // connection pool, as a second server would have.
  let otherApp: INestApplication;
  let prisma: PrismaService;
  let live: LivePublisher;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let userToken: string;
  let hostToken: string;
  let originalCreditsState: CreditsStateRow = null;
  let publishSpy: jest.SpyInstance;

  const newKey = () => `inbox05-${randomUUID()}`;

  async function setCredits(creditBalance: number): Promise<void> {
    await prisma.creditsState.upsert({
      where: { userWawuId: USER_PLAIN },
      update: { creditBalance, trialEndsAt: null },
      create: { userWawuId: USER_PLAIN, creditBalance, trialEndsAt: null },
    });
  }

  const balance = async () =>
    (
      await prisma.creditsState.findUnique({
        where: { userWawuId: USER_PLAIN },
      })
    )?.creditBalance;

  const rowsWith = (text: string, sender = USER_PLAIN) =>
    prisma.communityMessage.findMany({
      where: { communityId: ROOM, senderWawuId: sender, text },
    });

  const countSpends = () =>
    prisma.creditSpend.count({
      where: { userWawuId: USER_PLAIN, communityId: ROOM },
    });
  // The ledger rows this test added, whatever the earlier tests left.
  let spendsBefore = 0;
  const spends = async () => (await countSpends()) - spendsBefore;

  function post(
    on: INestApplication,
    token: string,
    body: Record<string, unknown>,
    key?: string,
    room = ROOM,
  ) {
    let req = request(on.getHttpServer() as App)
      .post(`/communities/${room}/messages`)
      .set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body);
  }

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
    userToken = await login('user@test.wawu.dev');
    hostToken = await login('creator-pro@test.wawu.dev');

    ({ app, prisma, live } = await boot());
    ({ app: otherApp } = await boot());

    originalCreditsState = await prisma.creditsState.findUnique({
      where: { userWawuId: USER_PLAIN },
    });

    for (const [id, name] of [
      [ROOM, 'INBOX-05 key room'],
      [OTHER_ROOM, 'INBOX-05 key other room'],
    ] as const) {
      await prisma.community.create({
        data: {
          id,
          name,
          description: 'Fixture for the Idempotency-Key spec.',
          hostWawuId: HOST,
          kind: 'open',
        },
      });
      await prisma.communityMembership.create({
        data: {
          userWawuId: USER_PLAIN,
          communityId: id,
          status: 'joined',
          joinedAt: new Date(),
        },
      });
    }
  }, 60000);

  beforeEach(async () => {
    publishSpy = jest.spyOn(live, 'publish');
    spendsBefore = await countSpends();
  });

  afterEach(() => {
    publishSpy.mockRestore();
  });

  afterAll(async () => {
    // Messages, key rows, credit spends and memberships all go with the rooms.
    await prisma.community.deleteMany({
      where: { id: { in: [ROOM, OTHER_ROOM] } },
    });
    if (originalCreditsState) {
      await prisma.creditsState.update({
        where: { userWawuId: USER_PLAIN },
        data: {
          creditBalance: originalCreditsState.creditBalance,
          trialEndsAt: originalCreditsState.trialEndsAt,
        },
      });
    } else {
      await prisma.creditsState.deleteMany({
        where: { userWawuId: USER_PLAIN },
      });
    }
    await app?.close();
    await otherApp?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  describe('a send without the header', () => {
    it('is unchanged: the same words twice are two messages and two credits', async () => {
      await setCredits(10);
      const first = await post(app, userToken, { text: 'no key twice' });
      const second = await post(app, userToken, { text: 'no key twice' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(bodyOf(second).data.id).not.toBe(bodyOf(first).data.id);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(await balance()).toBe(8);
      expect(await rowsWith('no key twice')).toHaveLength(2);
      expect(
        await prisma.communityMessageKey.count({
          where: { senderWawuId: USER_PLAIN },
        }),
      ).toBe(0);
    });
  });

  describe('a repeat of a send (the answer was lost)', () => {
    it('answers with the first message, the same status and body, and stores and charges nothing more', async () => {
      await setCredits(10);
      const key = newKey();
      const first = await post(app, userToken, { text: 'once only' }, key);
      expect(first.status).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await balance()).toBe(9);

      const repeat = await post(app, userToken, { text: 'once only' }, key);
      expect(repeat.status).toBe(first.status);
      expect(repeat.body).toEqual(first.body);
      expect(repeat.headers['idempotent-replayed']).toBe('true');

      expect(await balance()).toBe(9);
      expect(await rowsWith('once only')).toHaveLength(1);
      expect(await spends()).toBe(1);
      // The live event went out when the first request stored it, not again.
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('answers a repeat that sends the words with other spacing as the same message', async () => {
      await setCredits(10);
      const key = newKey();
      const first = await post(app, userToken, { text: 'spaced' }, key);
      const repeat = await post(app, userToken, { text: '  spaced  ' }, key);
      expect(repeat.status).toBe(201);
      expect(bodyOf(repeat).data.id).toBe(bodyOf(first).data.id);
      expect(await balance()).toBe(9);
    });

    it('answers a repeat of the send that took the last credit with the first message, not 402', async () => {
      await setCredits(1);
      const key = newKey();
      const first = await post(app, userToken, { text: 'last credit' }, key);
      expect(first.status).toBe(201);
      expect(await balance()).toBe(0);
      const repeat = await post(app, userToken, { text: 'last credit' }, key);
      expect(repeat.status).toBe(201);
      expect(repeat.body).toEqual(first.body);
      expect(await balance()).toBe(0);
    });

    it("answers the host's repeat with the first message too (the host pays nothing, the message is stored once)", async () => {
      const key = newKey();
      const first = await post(app, hostToken, { text: 'host once' }, key);
      expect(first.status).toBe(201);
      expect(bodyOf(first).data.costInCredits).toBe(0);
      const repeat = await post(app, hostToken, { text: 'host once' }, key);
      expect(repeat.status).toBe(201);
      expect(repeat.body).toEqual(first.body);
      expect(repeat.headers['idempotent-replayed']).toBe('true');
      expect(await rowsWith('host once', HOST)).toHaveLength(1);
    });

    it('is refused like any send once the person has lost the room: a repeat is not an answer to a stranger', async () => {
      await setCredits(10);
      const key = newKey();
      await post(app, userToken, { text: 'before leaving' }, key);
      // A removed member has no membership row.
      await prisma.communityMembership.delete({
        where: {
          userWawuId_communityId: { userWawuId: USER_PLAIN, communityId: ROOM },
        },
      });
      try {
        const repeat = await post(
          app,
          userToken,
          { text: 'before leaving' },
          key,
        );
        expect(repeat.status).toBe(403);
      } finally {
        await prisma.communityMembership.create({
          data: {
            userWawuId: USER_PLAIN,
            communityId: ROOM,
            status: 'joined',
            joinedAt: new Date(),
          },
        });
      }
    });
  });

  describe('two requests with one key at the same moment', () => {
    it('on one server store and charge once, and both answer with the one message', async () => {
      await setCredits(10);
      const key = newKey();
      const [a, b] = await Promise.all([
        post(app, userToken, { text: 'raced on one server' }, key),
        post(app, userToken, { text: 'raced on one server' }, key),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(bodyOf(a).data.id).toBe(bodyOf(b).data.id);
      expect(
        [a, b].filter((r) => r.headers['idempotent-replayed'] === 'true'),
      ).toHaveLength(1);
      expect(await rowsWith('raced on one server')).toHaveLength(1);
      expect(await spends()).toBe(1);
      expect(await balance()).toBe(9);
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('on two servers (two applications, two connection pools) store and charge once, in every one of ten rounds', async () => {
      await setCredits(50);
      for (let round = 0; round < 10; round += 1) {
        const key = newKey();
        const text = `raced on two servers ${round}`;
        const [a, b] = await Promise.all([
          post(app, userToken, { text }, key),
          post(otherApp, userToken, { text }, key),
        ]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(bodyOf(a).data.id).toBe(bodyOf(b).data.id);
        expect(await rowsWith(text)).toHaveLength(1);
      }
      expect(await balance()).toBe(40);
      expect(await spends()).toBe(10);
    });

    it('with a balance of exactly one credit: both answer with the one message and neither is told it has no credits', async () => {
      await setCredits(1);
      const key = newKey();
      const [a, b] = await Promise.all([
        post(app, userToken, { text: 'one credit, two requests' }, key),
        post(otherApp, userToken, { text: 'one credit, two requests' }, key),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(bodyOf(a).data.id).toBe(bodyOf(b).data.id);
      expect(await rowsWith('one credit, two requests')).toHaveLength(1);
      expect(await balance()).toBe(0);
    });

    it('from the host on two servers store the one message', async () => {
      const key = newKey();
      const [a, b] = await Promise.all([
        post(app, hostToken, { text: 'host raced' }, key),
        post(otherApp, hostToken, { text: 'host raced' }, key),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(bodyOf(a).data.id).toBe(bodyOf(b).data.id);
      expect(await rowsWith('host raced', HOST)).toHaveLength(1);
    });

    it('with five requests at once still store and charge once', async () => {
      await setCredits(10);
      const key = newKey();
      const answers = await Promise.all(
        [app, otherApp, app, otherApp, app].map((on) =>
          post(on, userToken, { text: 'five at once' }, key),
        ),
      );
      expect(answers.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(answers.map((r) => bodyOf(r).data.id)).size).toBe(1);
      expect(await rowsWith('five at once')).toHaveLength(1);
      expect(await balance()).toBe(9);
    });

    it('different keys at once are different messages', async () => {
      await setCredits(10);
      const [a, b] = await Promise.all([
        post(app, userToken, { text: 'two keys' }, newKey()),
        post(otherApp, userToken, { text: 'two keys' }, newKey()),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(bodyOf(a).data.id).not.toBe(bodyOf(b).data.id);
      expect(await rowsWith('two keys')).toHaveLength(2);
      expect(await balance()).toBe(8);
    });
  });

  describe('a key belongs to one message and one sender', () => {
    it('the same key for other words is refused with 409 idempotency_key_reused, and nothing is stored or charged', async () => {
      await setCredits(10);
      const key = newKey();
      await post(app, userToken, { text: 'the first words' }, key);
      const other = await post(app, userToken, { text: 'other words' }, key);
      expect(other.status).toBe(409);
      expect(bodyOf(other).reason).toBe('idempotency_key_reused');
      expect(await rowsWith('other words')).toHaveLength(0);
      expect(await balance()).toBe(9);
    });

    it('the same key for another room is refused the same way', async () => {
      await setCredits(10);
      const key = newKey();
      await post(app, userToken, { text: 'in the first room' }, key);
      const other = await post(
        app,
        userToken,
        { text: 'in the first room' },
        key,
        OTHER_ROOM,
      );
      expect(other.status).toBe(409);
      expect(bodyOf(other).reason).toBe('idempotency_key_reused');
      expect(await balance()).toBe(9);
    });

    it('another sender using the same key is a different message', async () => {
      await setCredits(10);
      const key = newKey();
      const mine = await post(
        app,
        userToken,
        { text: 'same key, two people' },
        key,
      );
      const theirs = await post(
        app,
        hostToken,
        { text: 'same key, two people' },
        key,
      );
      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      expect(bodyOf(theirs).data.id).not.toBe(bodyOf(mine).data.id);
      expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    });
  });

  describe('a send that is refused does not use up its key', () => {
    it('402 stores nothing and takes no credit; the same key then stores once when the person has a credit', async () => {
      await setCredits(0);
      const key = newKey();
      const refused = await post(app, userToken, { text: 'after buying' }, key);
      expect(refused.status).toBe(402);
      expect(await rowsWith('after buying')).toHaveLength(0);
      expect(
        await prisma.communityMessageKey.count({
          where: { senderWawuId: USER_PLAIN, key },
        }),
      ).toBe(0);

      await setCredits(5);
      const sent = await post(app, userToken, { text: 'after buying' }, key);
      expect(sent.status).toBe(201);
      const repeat = await post(app, userToken, { text: 'after buying' }, key);
      expect(bodyOf(repeat).data.id).toBe(bodyOf(sent).data.id);
      expect(await rowsWith('after buying')).toHaveLength(1);
      expect(await balance()).toBe(4);
    });

    it('an empty message is refused with 400 before the key is looked at', async () => {
      await setCredits(5);
      const res = await post(app, userToken, { text: '   ' }, newKey());
      expect(res.status).toBe(400);
      expect(await balance()).toBe(5);
    });
  });

  describe('the header itself', () => {
    it.each([
      ['too short', 'abc'],
      ['too long', 'k'.repeat(129)],
      ['with a space', 'has a space in it'],
      ['with a slash', 'bad/key/value'],
    ])(
      'a key %s is refused with 400 and nothing is sent',
      async (_name, key) => {
        await setCredits(5);
        const res = await post(app, userToken, { text: 'bad key' }, key);
        expect(res.status).toBe(400);
        expect(await rowsWith('bad key')).toHaveLength(0);
        expect(await balance()).toBe(5);
      },
    );

    it('a key of 8 and one of 128 allowed characters are accepted', async () => {
      await setCredits(5);
      const short = await post(
        app,
        userToken,
        { text: 'short key' },
        'abcd-_12',
      );
      const long = await post(
        app,
        userToken,
        { text: 'long key' },
        'K_-'.repeat(42) + 'Zz',
      );
      expect(short.status).toBe(201);
      expect(long.status).toBe(201);
    });
  });

  describe('what a message looks like', () => {
    it('carries no key: not in the answer to the send, not in the list', async () => {
      await setCredits(5);
      const key = newKey();
      const sent = await post(
        app,
        userToken,
        { text: 'no key on the row' },
        key,
      );
      expect(Object.keys(bodyOf(sent).data).sort()).toEqual(
        [
          'communityId',
          'costInCredits',
          'id',
          'imageUrl',
          'senderWawuId',
          'sentAt',
          'text',
        ].sort(),
      );
      const list = await request(app.getHttpServer() as App)
        .get(`/communities/${ROOM}/messages`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(list.status).toBe(200);
      const found = (list.body as { data: { id: string }[] }).data.find(
        (m) => m.id === bodyOf(sent).data.id,
      );
      expect(found).toBeDefined();
      expect(JSON.stringify(list.body)).not.toContain(key);
    });

    it('goes with its room: deleting a message takes its key row with it', async () => {
      await setCredits(5);
      const key = newKey();
      const sent = await post(app, userToken, { text: 'to be deleted' }, key);
      await prisma.communityMessage.delete({
        where: { id: bodyOf(sent).data.id },
      });
      expect(
        await prisma.communityMessageKey.count({
          where: { senderWawuId: USER_PLAIN, key },
        }),
      ).toBe(0);
    });
  });
});
