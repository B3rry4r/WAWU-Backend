// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// task brief), mirroring src/creator-subscription/tests's own precedent —
// PrismaService reads process.env.DATABASE_URL directly (not via
// ConfigService), so this must be set before PrismaModule/PrismaService is
// ever instantiated below.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { DirectMessageModule } from '../direct-message.module';
import { MOCK_FAILURE_TRANSACTION_ID } from '../mock-flutterwave.adapter';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // Adaeze Okonkwo — plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Chidi Umeh — Basic tier, dmPrice 100
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Zainab Bello — Pro tier, dmPrice 300

// Seeded DirectMessage row (prisma/seed.ts): plain -> pro creator, ₦300,
// awaiting_response, deadline 24h from seed-run time.
const DM_PLAIN_TO_PRO = '90000000-0000-4000-8000-000000000001'; // matches prisma/seed.ts's own literal exactly

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

describe('DirectMessage (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorBasicToken: string;
  let creatorProToken: string;

  // Snapshot of the seeded CreatorState rows this suite reads (and, in one
  // test, temporarily mutates) — restored in afterAll so reruns of this
  // suite, and any other resource's suite sharing wawu_hub_test, see stable
  // seeded state (mirrors src/creator-subscription/tests's own documented
  // precedent).
  let originalBasicState: Awaited<
    ReturnType<PrismaService['creatorState']['findUniqueOrThrow']>
  >;

  // IDs of every DirectMessage row THIS suite creates — deleted in afterAll.
  const createdMessageIds: string[] = [];

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    userToken = await login('user@test.wawu.dev');
    creatorBasicToken = await login('creator-basic@test.wawu.dev');
    creatorProToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        DirectMessageModule,
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

    originalBasicState = await prisma.creatorState.findUniqueOrThrow({
      where: { wawuUserId: USER_CREATOR_BASIC },
    });
  }, 30000);

  afterAll(async () => {
    if (prisma) {
      // Restore the Basic creator's CreatorState in case the
      // "dmEnabled=false rejects send" test toggled it.
      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: {
          dmPrice: originalBasicState.dmPrice,
          dmEnabled: originalBasicState.dmEnabled,
        },
      });

      // Delete every DirectMessage row this suite created (verify-created
      // rows + respond-flow fixtures) — never touch the seeded
      // DM_PLAIN_TO_PRO row itself, only read it.
      if (createdMessageIds.length > 0) {
        await prisma.directMessage.deleteMany({
          where: { id: { in: createdMessageIds } },
        });
      }
    }

    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('POST /dm/:creatorWawuId/send (roles: any)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .send({ text: 'hi' })
        .expect(401);
    });

    it('400s on an empty text body', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: '' })
        .expect(400);
    });

    it('400s when the target creatorWawuId is not a valid UUID', async () => {
      await request(app.getHttpServer())
        .post('/dm/not-a-uuid/send')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'hi' })
        .expect(400);
    });

    it('404s for a creatorWawuId that has no CreatorState at all', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${USER_PLAIN}/send`) // USER_PLAIN is a plain account, no CreatorState row
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ text: 'hi' })
        .expect(404);
    });

    it('400s a self-DM attempt', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ text: 'hi myself' })
        .expect(400);
    });

    it('403s when the target creator has dmEnabled=false', async () => {
      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: { dmEnabled: false },
      });

      await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_BASIC}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'hi' })
        .expect(403);

      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: { dmEnabled: originalBasicState.dmEnabled },
      });
    });

    it('inits a Flutterwave charge at the creator dmPrice and returns a threadId (200/201)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'Can you review my pitch deck?' });
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.flutterwaveConfig).toEqual(
        expect.objectContaining({
          amount: 300, // seeded USER_CREATOR_PRO.dmPrice
          currency: 'NGN',
          txRef: expect.any(String),
        }),
      );
      expect(typeof res.body.data.threadId).toBe('string');

      // Not yet a real row — send/verify hasn't run.
      const row = await prisma.directMessage.findUnique({
        where: { id: res.body.data.threadId },
      });
      expect(row).toBeNull();
    });
  });

  describe('POST /dm/:messageId/send/verify (roles: any)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send/verify`)
        .send({ transaction_id: 'x', tx_ref: 'y' })
        .expect(401);
    });

    it('404s for a messageId that was never sent-init', async () => {
      await request(app.getHttpServer())
        .post(`/dm/00000000-0000-4000-8000-0000000000ff/send/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'whatever', tx_ref: 'no-such-ref' })
        .expect(404);
    });

    it("404s when a different user tries to verify someone else's pending send", async () => {
      const initRes = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'mine, not yours' });
      const { threadId, flutterwaveConfig } = initRes.body.data;

      await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ transaction_id: 'irrelevant', tx_ref: flutterwaveConfig.txRef })
        .expect(404);
    });

    it('400s verify on a failed Flutterwave transaction, then 404s a second verify against the same reference', async () => {
      const initRes = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'will fail verification' });
      const { threadId, flutterwaveConfig } = initRes.body.data;

      await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          transaction_id: MOCK_FAILURE_TRANSACTION_ID,
          tx_ref: flutterwaveConfig.txRef,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'irrelevant', tx_ref: flutterwaveConfig.txRef })
        .expect(404);

      // No row was created for the failed attempt.
      const row = await prisma.directMessage.findUnique({
        where: { id: threadId },
      });
      expect(row).toBeNull();
    });

    it('completes the full send flow: creates the DirectMessage row with a snapshotted amount and a 24h deadline', async () => {
      const initRes = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'Can you help me pick a business structure?' });
      const { threadId, flutterwaveConfig } = initRes.body.data;

      const beforeVerify = Date.now();
      const verifyRes = await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          transaction_id: 'real-looking-tx-id',
          tx_ref: flutterwaveConfig.txRef,
        });
      expect([200, 201]).toContain(verifyRes.status);
      createdMessageIds.push(threadId);

      expect(verifyRes.body.data).toEqual(
        expect.objectContaining({
          id: threadId,
          creatorWawuId: USER_CREATOR_PRO,
          senderWawuId: USER_PLAIN,
          text: 'Can you help me pick a business structure?',
          amount: 300,
          status: 'awaiting_response',
          flutterwaveTxRef: flutterwaveConfig.txRef,
        }),
      );

      const deadlineAt = new Date(verifyRes.body.data.deadlineAt).getTime();
      const sentAt = new Date(verifyRes.body.data.sentAt).getTime();
      expect(deadlineAt - sentAt).toBe(24 * 60 * 60 * 1000);
      expect(sentAt).toBeGreaterThanOrEqual(beforeVerify);

      const row = await prisma.directMessage.findUnique({
        where: { id: threadId },
      });
      expect(row?.status).toBe('awaiting_response');
    });
  });

  describe('POST /dm/:messageId/respond (roles: creator, must be the target creator)', () => {
    let respondMessageId: string;

    beforeAll(async () => {
      // Fresh DM created via the real send+verify flow, targeting the Basic
      // creator, for this describe block's respond tests.
      const initRes = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_BASIC}/send`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'Question for the respond-flow tests' });
      const { threadId, flutterwaveConfig } = initRes.body.data;

      const verifyRes = await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          transaction_id: 'real-looking-tx-id',
          tx_ref: flutterwaveConfig.txRef,
        });
      respondMessageId = verifyRes.body.data.id;
      createdMessageIds.push(respondMessageId);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${respondMessageId}/respond`)
        .send({ text: 'hi' })
        .expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${respondMessageId}/respond`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'hi' })
        .expect(403);
    });

    it("403s a creator who is NOT the DM's target creator", async () => {
      await request(app.getHttpServer())
        .post(`/dm/${respondMessageId}/respond`)
        .set('Authorization', `Bearer ${creatorProToken}`) // this DM was sent to Basic, not Pro
        .send({ text: 'not mine to answer' })
        .expect(403);
    });

    it('404s for a non-existent messageId', async () => {
      await request(app.getHttpServer())
        .post('/dm/00000000-0000-4000-8000-0000000000ff/respond')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ text: 'hi' })
        .expect(404);
    });

    it('409s a response after the deadline has passed (defensive real-time check)', async () => {
      await prisma.directMessage.update({
        where: { id: respondMessageId },
        data: { deadlineAt: new Date(Date.now() - 1000) },
      });

      await request(app.getHttpServer())
        .post(`/dm/${respondMessageId}/respond`)
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ text: 'too late' })
        .expect(409);

      // Status is left untouched by this endpoint — still awaiting_response,
      // not silently flipped to refunded (that is the deferred cron's job).
      const row = await prisma.directMessage.findUnique({
        where: { id: respondMessageId },
      });
      expect(row?.status).toBe('awaiting_response');

      // Restore a live deadline for the success-path test below.
      await prisma.directMessage.update({
        where: { id: respondMessageId },
        data: { deadlineAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
    });

    it('sets status=responded, respondedAt, responseText on success (200/201) — the payout-release signal', async () => {
      const res = await request(app.getHttpServer())
        .post(`/dm/${respondMessageId}/respond`)
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ text: 'Here is my answer!' });
      expect([200, 201]).toContain(res.status);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          id: respondMessageId,
          status: 'responded',
          responseText: 'Here is my answer!',
        }),
      );
      expect(res.body.data.respondedAt).not.toBeNull();
    });

    it('409s a second respond attempt on an already-responded DM', async () => {
      await request(app.getHttpServer())
        .post(`/dm/${respondMessageId}/respond`)
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ text: 'again?' })
        .expect(409);
    });
  });

  describe('GET /dm/inbox (roles: creator)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/dm/inbox').expect(401);
    });

    it('403s for a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .get('/dm/inbox')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it("returns the Pro creator's incoming DMs, including the seeded one", async () => {
      const res = await request(app.getHttpServer())
        .get('/dm/inbox')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(
        res.body.data.every(
          (dm: { creatorWawuId: string }) =>
            dm.creatorWawuId === USER_CREATOR_PRO,
        ),
      ).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ currentPage: 1, perPage: 20 }),
      );
      const seeded = res.body.data.find(
        (dm: { id: string }) => dm.id === DM_PLAIN_TO_PRO,
      );
      expect(seeded).toBeDefined();
      expect(seeded.deadlineAt).toBeDefined();
    });
  });

  describe('GET /dm/threads (roles: any)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/dm/threads').expect(401);
    });

    it("returns the caller's own sent DMs, including the seeded one", async () => {
      const res = await request(app.getHttpServer())
        .get('/dm/threads')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(
        res.body.data.every(
          (dm: { senderWawuId: string }) => dm.senderWawuId === USER_PLAIN,
        ),
      ).toBe(true);
      const seeded = res.body.data.find(
        (dm: { id: string }) => dm.id === DM_PLAIN_TO_PRO,
      );
      expect(seeded).toBeDefined();
    });

    it('a creator with no sent DMs gets an empty (not error) page', async () => {
      const res = await request(app.getHttpServer())
        .get('/dm/threads')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /dm/:messageId (roles: any)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/dm/${DM_PLAIN_TO_PRO}`)
        .expect(401);
    });

    it('404s for a non-existent messageId', async () => {
      await request(app.getHttpServer())
        .get('/dm/00000000-0000-4000-8000-0000000000ff')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);
    });

    it('returns the DM for the sender (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/dm/${DM_PLAIN_TO_PRO}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.data.id).toBe(DM_PLAIN_TO_PRO);
    });

    it('returns the DM for the target creator (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/dm/${DM_PLAIN_TO_PRO}`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);
      expect(res.body.data.id).toBe(DM_PLAIN_TO_PRO);
    });

    it('404s (hides, not 403s) for a third party who is neither sender nor creator', async () => {
      const res = await request(app.getHttpServer())
        .get(`/dm/${DM_PLAIN_TO_PRO}`)
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(404);
      expect(res.body.data).toBeNull();
    });
  });
});
