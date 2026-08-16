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
import { CommunityMessageModule } from '../community-message.module';

// Seeded WAWU IDs / community — mirror mock-wawu-id/server.js and
// prisma/seed.ts exactly (see credit-spend's own contract spec, which
// documents the same fixtures this resource's ledger side-effect writes
// into).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // seeded community host

const SEEDED_COMMUNITY_ID = '20000000-0000-4000-8000-000000000001'; // "WAWU Founders Circle", host = USER_CREATOR_PRO
const NONEXISTENT_COMMUNITY_ID = '20000000-0000-4000-8000-00000000dead';

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

type CreditsStateRow = {
  userWawuId: string;
  creditBalance: number;
  trialEndsAt: Date;
} | null;

describe('CommunityMessage (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;

  // Rows this suite creates — deleted in afterAll (test hygiene).
  const createdMessageIds: string[] = [];
  const createdCreditSpendIds: string[] = [];

  // USER_PLAIN's CreditsState row as it existed before this suite touched
  // it (or null if it didn't exist yet) — restored exactly in afterAll.
  let originalCreditsState: CreditsStateRow = null;

  async function setCreditsState(
    creditBalance: number,
    trialEndsAt: Date,
  ): Promise<void> {
    await prisma.creditsState.upsert({
      where: { userWawuId: USER_PLAIN },
      update: { creditBalance, trialEndsAt },
      create: { userWawuId: USER_PLAIN, creditBalance, trialEndsAt },
    });
  }

  /**
   * POSTs a message and, on success, tracks BOTH the created message id and
   * the CreditSpend ledger row the send wrote (looked up as the newest
   * CreditSpend for this sender+community not already tracked — the send
   * path is sequential/awaited in every test here, so "newest, untracked"
   * unambiguously identifies the row this call just created). Centralizing
   * this here (rather than duplicating id-capture per test) is what keeps
   * every successful send's ledger side-effect covered by afterAll cleanup.
   */
  async function sendMessage(text: string) {
    const res = await request(app.getHttpServer())
      .post(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ text });

    if (res.body?.data?.id) {
      createdMessageIds.push(res.body.data.id);

      const spend = await prisma.creditSpend.findFirst({
        where: {
          userWawuId: USER_PLAIN,
          communityId: SEEDED_COMMUNITY_ID,
          id: {
            notIn:
              createdCreditSpendIds.length > 0
                ? createdCreditSpendIds
                : undefined,
          },
        },
        orderBy: { spentAt: 'desc' },
      });
      if (spend) {
        createdCreditSpendIds.push(spend.id);
      }
    }

    return res;
  }

  async function restoreCreditsState(): Promise<void> {
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
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    userToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityMessageModule,
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

    originalCreditsState = await prisma.creditsState.findUnique({
      where: { userWawuId: USER_PLAIN },
    });
  }, 30000);

  afterAll(async () => {
    // Clean up everything this suite created, then restore the shared
    // seeded CreditsState row exactly as we found it.
    if (createdMessageIds.length > 0) {
      await prisma.communityMessage.deleteMany({
        where: { id: { in: createdMessageIds } },
      });
    }
    if (createdCreditSpendIds.length > 0) {
      await prisma.creditSpend.deleteMany({
        where: { id: { in: createdCreditSpendIds } },
      });
    }
    await restoreCreditsState();

    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /communities/:id/messages', () => {
    it('returns a paginated, newest-first list of messages for a valid community (200)', async () => {
      // Ensure at least a real balance so both sends succeed and land as
      // real, ordered rows (not gated).
      await setCreditsState(50, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

      const first = await sendMessage('ordering-probe-first');
      expect([200, 201]).toContain(first.status);

      const second = await sendMessage('ordering-probe-second');
      expect([200, 201]).toContain(second.status);

      const res = await request(app.getHttpServer())
        .get(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({
          currentPage: 1,
          perPage: 20,
          total: expect.any(Number),
        }),
      );

      const ids: string[] = res.body.data.map((m: { id: string }) => m.id);
      const firstIndex = ids.indexOf(first.body.data.id);
      const secondIndex = ids.indexOf(second.body.data.id);
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThanOrEqual(0);
      // Newest-first (sentAt desc): the message sent second must appear
      // BEFORE the message sent first — matches CommentService's own
      // `createdAt: 'desc'` precedent (the one chat-like sibling in this
      // codebase).
      expect(secondIndex).toBeLessThan(firstIndex);
    });

    it('404s for a community that does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get(`/communities/${NONEXISTENT_COMMUNITY_ID}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
        .expect(401);
    });
  });

  describe('POST /communities/:id/messages', () => {
    afterEach(async () => {
      await restoreCreditsState();
    });

    it('creates a message and decrements a real balance by costInCredits (1)', async () => {
      await setCreditsState(10, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

      const res = await sendMessage('Hello, community!');

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          communityId: SEEDED_COMMUNITY_ID,
          senderWawuId: USER_PLAIN,
          text: 'Hello, community!',
          costInCredits: 1,
        }),
      );

      const stored = await prisma.communityMessage.findUnique({
        where: { id: res.body.data.id },
      });
      expect(stored).not.toBeNull();

      const state = await prisma.creditsState.findUnique({
        where: { userWawuId: USER_PLAIN },
      });
      expect(state?.creditBalance).toBe(9); // 10 - 1

      // CreditSpend ledger side-effect: one row, attributed to the
      // community's host as creatorWawuId.
      const spend = await prisma.creditSpend.findFirst({
        where: { userWawuId: USER_PLAIN, communityId: SEEDED_COMMUNITY_ID },
        orderBy: { spentAt: 'desc' },
      });
      expect(spend).not.toBeNull();
      expect(spend?.creatorWawuId).toBe(USER_CREATOR_PRO);
      expect(spend?.creditsSpent).toBe(1);
    });

    it('allows a trial-covered send with 0 balance and does NOT decrement below 0', async () => {
      await setCreditsState(0, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // trial active, no balance

      const res = await sendMessage('Trial-covered message');

      expect([200, 201]).toContain(res.status);

      const state = await prisma.creditsState.findUnique({
        where: { userWawuId: USER_PLAIN },
      });
      expect(state?.creditBalance).toBe(0); // stays at 0, never goes negative

      const spend = await prisma.creditSpend.findFirst({
        where: { userWawuId: USER_PLAIN, communityId: SEEDED_COMMUNITY_ID },
        orderBy: { spentAt: 'desc' },
      });
      expect(spend).not.toBeNull();
    });

    it('402s with a buy-more-credits rejection when balance is 0 and the trial has ended', async () => {
      await setCreditsState(0, new Date(Date.now() - 1000)); // trial expired, no balance

      const res = await request(app.getHttpServer())
        .post(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'This should be rejected' })
        .expect(402);

      expect(res.body.data).toBeNull();
      expect(res.body.message.toLowerCase()).toEqual(
        expect.stringContaining('credit'),
      );

      const messages = await prisma.communityMessage.findMany({
        where: {
          communityId: SEEDED_COMMUNITY_ID,
          senderWawuId: USER_PLAIN,
          text: 'This should be rejected',
        },
      });
      expect(messages.length).toBe(0);

      const state = await prisma.creditsState.findUnique({
        where: { userWawuId: USER_PLAIN },
      });
      expect(state?.creditBalance).toBe(0); // unchanged
    });

    it('404s for a community that does not exist (checked before the credits gate)', async () => {
      await setCreditsState(0, new Date(Date.now() - 1000)); // would also fail the gate — 404 must win

      const res = await request(app.getHttpServer())
        .post(`/communities/${NONEXISTENT_COMMUNITY_ID}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'irrelevant' })
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('400s on an invalid payload (empty text)', async () => {
      await setCreditsState(10, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

      const res = await request(app.getHttpServer())
        .post(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: '' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await setCreditsState(10, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

      await request(app.getHttpServer())
        .post(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'hello', costInCredits: 999 })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/communities/${SEEDED_COMMUNITY_ID}/messages`)
        .send({ text: 'no auth' })
        .expect(401);
    });
  });
});
