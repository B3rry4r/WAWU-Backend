// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
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
import {
  GEMINI_CLIENT,
  type GeminiChatRequest,
  type GeminiClient,
} from '../../common/ai/gemini-client.interface';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { LegalChatService } from '../legal-chat.service';
import { LegalIntakeModule } from '../legal-intake.module';
import {
  ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
  ASSISTANT_OPENER_ATTEMPTS_PER_HOUR,
} from '../assistant/legal-assistant-config';

/**
 * FIX-11: the legal thread's opener is written once, metered and locked.
 *
 * `GET /legal/intake/chat/{requestId}` writes the assistant's opener on the
 * first read of an empty, paid thread. That is a paid AI call nobody typed,
 * so reading must never multiply it: parallel reads make ONE call and all see
 * its opener, and the call counts toward the person's hourly allowance like
 * every other assistant call. The AI provider is a stand-in at its seam
 * (`GEMINI_CLIENT`) that counts its calls; no real provider is ever called.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

const ME = '00000000-0000-4000-8000-000000000002';
const ME_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER = '00000000-0000-4000-8000-000000000003';
const OPENER_ASK =
  'I have just paid for my consultation. Open the conversation: greet me briefly, show me you have read my intake by referring to it specifically, say plainly that you are an assistant and not my lawyer, and ask me the single most useful question while I wait.';
const OPENER_TEXT = 'Hello. I have read your intake about your rent.';
const ANSWER_TEXT = 'Thank you. When did the landlord write to you?';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/** The AI provider, stood in at its seam. Counts every call it is given. */
class StandIn implements GeminiClient {
  chats: GeminiChatRequest[] = [];
  delayMs = 150;
  fail = false;
  reset() {
    this.chats = [];
    this.delayMs = 150;
    this.fail = false;
  }
  async chat(req: GeminiChatRequest): Promise<string> {
    this.chats.push(req);
    if (this.delayMs) await sleep(this.delayMs);
    if (this.fail) throw new Error('stand-in provider failure');
    return req.history[0]?.text === OPENER_ASK ? OPENER_TEXT : ANSWER_TEXT;
  }
  generateBrief(): Promise<never> {
    return Promise.reject(new Error('not used by the matter thread'));
  }
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** A throwaway WAWU ID account, for the purge (never a seeded one). */
let throwawayNonce = 0;
async function registerThrowawayIdentity(): Promise<{
  sub: string;
  accessToken: string;
}> {
  const nonce = `${Date.now().toString().slice(-8)}${(throwawayNonce += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Legal Opener Throwaway',
      email: `legal-opener-${nonce}@test.wawu.dev`,
      phone: `+2349${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, accessToken: body.accessToken };
}

interface Line {
  id: string;
  authorRole: string;
  body: string;
}
interface ThreadView {
  legalRequestId: string;
  consultantJoined: boolean;
  messages: Line[];
}
interface Res {
  status: number;
  body: unknown;
}
const data = (res: Res) => (res.body as { data: ThreadView }).data;
const reason = (res: Res) =>
  (res.body as { reason?: { code?: string; retryAfterSeconds?: unknown } })
    .reason;

async function makeApp(ai: GeminiClient): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      LegalIntakeModule,
    ],
  })
    .overrideProvider(GEMINI_CLIENT)
    .useValue(ai)
    .compile();
  const app = moduleRef.createNestApplication();
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
  // Listening once up front, so parallel requests do not each open it.
  await app.listen(0);
  return app;
}

describe('The legal thread opener: written once, metered and locked (FIX-11, contract)', () => {
  let app: INestApplication;
  /** A second Hub on the same database: the claim lives in the database. */
  let app2: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let owned = false;
  let token: string;
  let otherToken: string;
  const ai = new StandIn();

  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const read = (id: string, on = app, t = token): Promise<Res> =>
    request(on.getHttpServer() as App)
      .get(`/api/hub/legal/intake/chat/${id}`)
      .set(as(t))
      .then((r) => ({ status: r.status, body: r.body as unknown }));
  const post = (id: string, body: string): Promise<Res> =>
    request(app.getHttpServer() as App)
      .post(`/api/hub/legal/intake/chat/${id}`)
      .set(as(token))
      .send({ body })
      .then((r) => ({ status: r.status, body: r.body as unknown }));
  const par = <T>(n: number, f: (i: number) => Promise<T>) =>
    Promise.all(Array.from({ length: n }, (_, i) => f(i)));

  /** A matter whose consultation is paid for, its thread still empty. */
  const paidThread = async (
    status:
      | 'consultation_scheduled'
      | 'awaiting_quote'
      | 'in_progress' = 'consultation_scheduled',
    wawuUserId = ME,
  ) =>
    (
      await prisma.legalRequest.create({
        data: {
          wawuUserId,
          serviceCode: 'tenancy',
          serviceName: 'Tenancy advice',
          category: 'property',
          path: 'consultation',
          status,
          details: {
            brief: {
              matter: 'property',
              matterLabel: 'Tenancy',
              facts: [{ question: 'Rent rise', answer: '60% mid-lease' }],
              documentCount: 0,
              analysis: {
                summary: 'A tenant faces a mid-lease rent rise.',
                keyIssues: [],
                questionsToClarify: ['What does the review clause say?'],
                risks: [],
              },
            },
          },
          documents: [],
        },
      })
    ).id;
  const lines = (id: string) =>
    prisma.legalChatMessage.findMany({
      where: { legalRequestId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const openerCalls = (id: string) =>
    prisma.legalChatOpenerCall.findMany({
      where: { legalRequestId: id },
      orderBy: { createdAt: 'asc' },
    });
  /** Calls the provider was asked to open a thread with. */
  const openerAsks = () =>
    ai.chats.filter((c) => c.history[0]?.text === OPENER_ASK).length;
  /** Counted spends in the hour for ME, seeded as earlier assistant calls. */
  const seedSpent = async (n: number) => {
    const earlier = await prisma.legalIntake.create({
      data: {
        wawuUserId: ME,
        matter: 'other',
        channel: 'assistant',
        status: 'converted',
      },
    });
    await prisma.legalAssistantCall.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        legalIntakeId: earlier.id,
        wawuUserId: ME,
        kind: 'reply',
        createdAt: new Date(Date.now() - 10 * 60_000 + i),
      })),
    });
    return earlier.id;
  };

  async function cleanUp() {
    const requests = await prisma.legalRequest.findMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
      select: { id: true },
    });
    const requestIds = requests.map((r) => r.id);
    await prisma.legalChatOpenerCall.deleteMany({
      where: {
        OR: [
          { wawuUserId: { in: [ME, OTHER] } },
          { legalRequestId: { in: requestIds } },
        ],
      },
    });
    if (requestIds.length > 0) {
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: requestIds } },
      });
    }
    await prisma.legalAssistantCall.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalIntakeMessage.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalIntake.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalRequest.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      owned = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }
    app = await makeApp(ai);
    app2 = await makeApp(ai);
    prisma = app.get(PrismaService);
    await cleanUp();
    token = await login(ME_EMAIL);
    otherToken = await login('creator-pro@test.wawu.dev');
  }, 40000);

  afterEach(async () => {
    await cleanUp();
    ai.reset();
  });

  afterAll(async () => {
    if (prisma) await cleanUp();
    await app2?.close();
    await app?.close();
    if (owned && mockWawuId) mockWawuId.kill();
  }, 30000);

  describe('parallel reads make one call and see one opener', () => {
    it('20 parallel reads of an empty paid thread make exactly 1 AI call, and all 20 see the same opener (3 threads)', async () => {
      for (let round = 0; round < 3; round += 1) {
        ai.reset();
        const id = await paidThread();
        const rs = await par(20, () => read(id));

        expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
        expect(ai.chats).toHaveLength(1);
        const stored = await lines(id);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          authorRole: 'ai',
          body: OPENER_TEXT,
        });
        for (const r of rs) {
          expect(data(r).messages).toEqual([
            expect.objectContaining({
              id: stored[0].id,
              authorRole: 'ai',
              body: OPENER_TEXT,
            }),
          ]);
          expect(data(r).consultantJoined).toBe(false);
        }
        const calls = await openerCalls(id);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          wawuUserId: ME,
          outcome: 'written',
          busyUntil: null,
        });
      }
    }, 60000);

    it('100 parallel reads split across two Hubs on one database make exactly 1 AI call', async () => {
      ai.delayMs = 300;
      const id = await paidThread();
      const rs = await par(100, (i) => read(id, i % 2 === 0 ? app : app2));

      expect(rs.map((r) => r.status)).toEqual(Array(100).fill(200));
      expect(ai.chats).toHaveLength(1);
      const stored = await lines(id);
      expect(stored).toHaveLength(1);
      expect(
        new Set(
          rs.map((r) =>
            data(r)
              .messages.map((m) => m.id)
              .join(),
          ),
        ),
      ).toEqual(new Set([stored[0].id]));
      expect(await openerCalls(id)).toHaveLength(1);
    }, 60000);

    it('a read of a thread that already has its opener makes no call and claims nothing', async () => {
      const id = await paidThread();
      await read(id);
      expect(ai.chats).toHaveLength(1);
      const rs = await par(10, () => read(id));
      expect(rs.map((r) => data(r).messages.length)).toEqual(Array(10).fill(1));
      expect(ai.chats).toHaveLength(1);
      expect(await openerCalls(id)).toHaveLength(1);
    }, 30000);

    it('the opener is asked for exactly as before: the matter brief and the one opening request', async () => {
      const id = await paidThread();
      await read(id);
      expect(ai.chats).toHaveLength(1);
      const [ask] = ai.chats;
      expect(ask.history).toEqual([{ role: 'user', text: OPENER_ASK }]);
      expect(ask.instruction).toContain(
        "--- The client's intake brief ---\nMatter: Tenancy",
      );
      expect(ask.instruction).toContain('- Rent rise 60% mid-lease');
      expect(ask.instruction).toContain(
        'Still unclear: What does the review clause say?',
      );
    }, 30000);
  });

  describe('the opener call is metered like every other assistant call', () => {
    it('it is written down for the person and counts in the hour: the opener takes the last of the allowance and the next message is 429', async () => {
      await seedSpent(ASSISTANT_CLIENT_MESSAGES_PER_HOUR - 1);
      const id = await paidThread();

      const first = await read(id);
      expect(first.status).toBe(200);
      expect(data(first).messages.map((m) => m.body)).toEqual([OPENER_TEXT]);
      const calls = await prisma.legalChatOpenerCall.findMany({
        where: { wawuUserId: ME },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].legalRequestId).toBe(id);

      // The opener was the 30th spend of the hour, so the client's first
      // message is refused like any message over the allowance.
      const sent = await post(id, 'My landlord wants 60% more.');
      expect(sent.status).toBe(429);
      expect(reason(sent)?.code).toBe('assistant_rate_limited');
      expect(typeof reason(sent)?.retryAfterSeconds).toBe('number');
      expect(ai.chats).toHaveLength(1);
      expect((await lines(id)).map((l) => l.authorRole)).toEqual(['ai']);
    }, 30000);

    it('over the hourly allowance, 20 parallel reads make no call, claim nothing and answer the empty thread; once it frees, the next read opens', async () => {
      const earlier = await seedSpent(ASSISTANT_CLIENT_MESSAGES_PER_HOUR);
      const id = await paidThread();

      const rs = await par(20, () => read(id));
      expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
      expect(rs.every((r) => data(r).messages.length === 0)).toBe(true);
      expect(ai.chats).toHaveLength(0);
      expect(await openerCalls(id)).toHaveLength(0);
      expect(await lines(id)).toHaveLength(0);

      await prisma.legalAssistantCall.deleteMany({
        where: { legalIntakeId: earlier },
      });
      const after = await read(id);
      expect(data(after).messages.map((m) => m.body)).toEqual([OPENER_TEXT]);
      expect(ai.chats).toHaveLength(1);
    }, 30000);

    it(`a failing provider: 20 parallel reads make 1 call, later reads 1 each, at most ${ASSISTANT_OPENER_ATTEMPTS_PER_HOUR} an hour, and the client can still write`, async () => {
      ai.fail = true;
      const id = await paidThread();

      const rs = await par(20, () => read(id));
      expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
      expect(rs.every((r) => data(r).messages.length === 0)).toBe(true);
      expect(ai.chats).toHaveLength(1);
      expect((await openerCalls(id)).map((c) => c.outcome)).toEqual(['failed']);

      ai.delayMs = 0;
      for (let i = 0; i < 10; i += 1) {
        const r = await read(id);
        expect(r.status).toBe(200);
        expect(data(r).messages).toEqual([]);
      }
      // Each failed try was a paid call and is counted; the tries stop at
      // the cap, so the reads did not spend the client's whole allowance.
      expect(ai.chats).toHaveLength(ASSISTANT_OPENER_ATTEMPTS_PER_HOUR);
      const calls = await openerCalls(id);
      expect(calls).toHaveLength(ASSISTANT_OPENER_ATTEMPTS_PER_HOUR);
      expect(calls.every((c) => c.outcome === 'failed')).toBe(true);
      expect(calls.every((c) => c.busyUntil === null)).toBe(true);

      // The provider is back: the client's own message is answered (the
      // allowance still has room), and no opener is stored after it.
      ai.fail = false;
      const sent = await post(id, 'Are you there?');
      expect(sent.status).toBe(201);
      expect(data(sent).messages.map((m) => [m.authorRole, m.body])).toEqual([
        ['client', 'Are you there?'],
        ['ai', ANSWER_TEXT],
      ]);
      expect(openerAsks()).toBe(ASSISTANT_OPENER_ATTEMPTS_PER_HOUR);
    }, 60000);
  });

  describe('the opener never lands after another line', () => {
    it('a consultant who writes while the opener call is in flight keeps the first line; the call is still counted', async () => {
      ai.delayMs = 400;
      const id = await paidThread();
      const pending = read(id);
      await waitFor(() => ai.chats.length === 1);

      await app
        .get(LegalChatService)
        .sendAsConsultant(id, 'admin-fix11-test', 'I have your file.');
      const r = await pending;

      expect(r.status).toBe(200);
      expect(data(r).messages.map((m) => m.authorRole)).toEqual(['consultant']);
      expect(data(r).consultantJoined).toBe(true);
      expect((await lines(id)).map((l) => l.authorRole)).toEqual([
        'consultant',
      ]);
      const calls = await openerCalls(id);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        outcome: 'superseded',
        busyUntil: null,
        wawuUserId: ME,
      });
    }, 30000);

    it('a client message sent while the opener call is in flight is answered, and the opener is not stored after it', async () => {
      ai.delayMs = 400;
      const id = await paidThread();
      const pending = read(id);
      await waitFor(() => ai.chats.length === 1);

      const sent = await post(id, 'My landlord wants 60% more.');
      await pending;

      expect(sent.status).toBe(201);
      expect((await lines(id)).map((l) => [l.authorRole, l.body])).toEqual([
        ['client', 'My landlord wants 60% more.'],
        ['ai', ANSWER_TEXT],
      ]);
      expect((await openerCalls(id)).map((c) => c.outcome)).toEqual([
        'superseded',
      ]);
      expect(ai.chats).toHaveLength(2);
    }, 30000);
  });

  describe('the claim', () => {
    it('a claim held by a Hub that died mid-call holds reads off until it lapses, then the next read opens', async () => {
      const id = await paidThread();
      await prisma.legalChatOpenerCall.create({
        data: {
          legalRequestId: id,
          wawuUserId: ME,
          busyUntil: new Date(Date.now() + 700),
        },
      });

      const startedAt = Date.now();
      const rs = await par(5, () => read(id));
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
      expect(rs.every((r) => data(r).messages.length === 0)).toBe(true);
      expect(ai.chats).toHaveLength(0);

      const after = await read(id);
      expect(data(after).messages.map((m) => m.body)).toEqual([OPENER_TEXT]);
      expect(ai.chats).toHaveLength(1);
      expect((await openerCalls(id)).map((c) => c.outcome)).toEqual([
        null,
        'written',
      ]);
    }, 30000);

    it('a claim that has already lapsed does not hold a read at all', async () => {
      const id = await paidThread();
      await prisma.legalChatOpenerCall.create({
        data: {
          legalRequestId: id,
          wawuUserId: ME,
          busyUntil: new Date(Date.now() - 1000),
        },
      });
      const r = await read(id);
      expect(data(r).messages.map((m) => m.body)).toEqual([OPENER_TEXT]);
      expect(ai.chats).toHaveLength(1);
    }, 30000);

    it('the database keeps at most one written opener per thread', async () => {
      const legalRequestId = randomUUID();
      await prisma.legalChatOpenerCall.create({
        data: { legalRequestId, wawuUserId: ME, outcome: 'failed' },
      });
      await prisma.legalChatOpenerCall.create({
        data: { legalRequestId, wawuUserId: ME, outcome: 'written' },
      });
      await expect(
        prisma.legalChatOpenerCall.create({
          data: { legalRequestId, wawuUserId: ME, outcome: 'written' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await prisma.legalChatOpenerCall.create({
        data: { legalRequestId, wawuUserId: ME, outcome: 'failed' },
      });
      expect(
        await prisma.legalChatOpenerCall.count({ where: { legalRequestId } }),
      ).toBe(3);
    });
  });

  describe('what did not change', () => {
    it('a thread that is not open yet is read empty with no call', async () => {
      const id = await paidThread('awaiting_quote');
      const rs = await par(5, () => read(id));
      expect(rs.map((r) => r.status)).toEqual(Array(5).fill(200));
      expect(rs.every((r) => data(r).messages.length === 0)).toBe(true);
      expect(ai.chats).toHaveLength(0);
      expect(await openerCalls(id)).toHaveLength(0);
    }, 30000);

    it("somebody else's thread is 403 and makes no call", async () => {
      const id = await paidThread();
      const r = await read(id, app, otherToken);
      expect(r.status).toBe(403);
      expect(ai.chats).toHaveLength(0);
      expect(await openerCalls(id)).toHaveLength(0);
    }, 30000);

    it("the consultant's read never opens the thread", async () => {
      const id = await paidThread();
      const view = await app.get(LegalChatService).getThreadForOps(id);
      expect(view.messages).toEqual([]);
      expect(ai.chats).toHaveLength(0);
      expect(await openerCalls(id)).toHaveLength(0);
    }, 30000);

    it('a message on a thread with its opener is answered and counted as before', async () => {
      const id = await paidThread('in_progress');
      await read(id);
      const sent = await post(id, 'My landlord wants 60% more.');
      expect(sent.status).toBe(201);
      expect(data(sent).messages.map((m) => [m.authorRole, m.body])).toEqual([
        ['ai', OPENER_TEXT],
        ['client', 'My landlord wants 60% more.'],
        ['ai', ANSWER_TEXT],
      ]);
      expect(ai.chats).toHaveLength(2);
      // The answer's history is the thread as written: the opener, then the
      // client's message.
      expect(ai.chats[1].history).toEqual([
        { role: 'model', text: OPENER_TEXT },
        { role: 'user', text: 'My landlord wants 60% more.' },
      ]);
    }, 30000);
  });

  describe('the bookkeeping table is owned and purged with the account', () => {
    it('deleting an account removes its LegalChatOpenerCall rows and no other account rows', async () => {
      const own = await registerThrowawayIdentity();
      expect([ME, OTHER]).not.toContain(own.sub);
      const ownCalls = () =>
        prisma.legalChatOpenerCall.count({ where: { wawuUserId: own.sub } });
      const ownRequests: string[] = [];
      try {
        // The seeded account's opener, to show the purge takes only its own.
        await read(await paidThread());
        expect(
          await prisma.legalChatOpenerCall.count({ where: { wawuUserId: ME } }),
        ).toBe(1);

        const id = await paidThread('consultation_scheduled', own.sub);
        ownRequests.push(id);
        const r = await read(id, app, own.accessToken);
        expect(data(r).messages.map((m) => m.body)).toEqual([OPENER_TEXT]);
        expect(await ownCalls()).toBe(1);

        const purge = await new AccountPurgeService(prisma).purge(own.sub);
        expect(purge.deleted['LegalChatOpenerCall.wawuUserId']).toBe(1);
        expect(await ownCalls()).toBe(0);
        expect(
          await prisma.legalChatOpenerCall.count({ where: { wawuUserId: ME } }),
        ).toBe(1);
      } finally {
        await new AccountPurgeService(prisma).purge(own.sub);
        await prisma.legalChatMessage.deleteMany({
          where: { legalRequestId: { in: ownRequests } },
        });
      }
    }, 30000);
  });
});
