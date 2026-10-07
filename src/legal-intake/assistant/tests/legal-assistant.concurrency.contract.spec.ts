// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { Client } from 'pg';
import * as path from 'path';
import {
  INestApplication,
  Logger,
  ValidationPipe,
  type LoggerService,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  GEMINI_CLIENT,
  type GeminiBriefRequest,
  type GeminiChatRequest,
  type GeminiClient,
} from '../../../common/ai/gemini-client.interface';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import { LegalChatService } from '../../legal-chat.service';
import { LegalIntakeModule } from '../../legal-intake.module';
import {
  ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR,
  ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
  ASSISTANT_CLIENT_MESSAGES_PER_INTAKE,
} from '../legal-assistant-config';

/**
 * LEGAL-01 round 2: the limits and the claims hold under PARALLEL requests.
 *
 * Every limit here exists to cap paid AI calls, so each test fires its
 * requests at once, against an AI stand-in that takes 150 ms to answer (long
 * enough that every request is inside the check before any answer is back),
 * and then counts what was stored and how many times the provider was
 * called. No real provider is ever called.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

const ME = '00000000-0000-4000-8000-000000000002';
const ME_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER = '00000000-0000-4000-8000-000000000003';
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

const TURN = {
  reply: 'Where is the property?',
  quickReplies: [],
  matter: 'property',
  headline: 'Tenancy · rent increase',
  facts: [{ label: 'Rent rise', value: '60% mid-lease' }],
  answers: {},
  briefReady: false,
};
const READY = { ...TURN, reply: 'Check it is right.', briefReady: true };

class SlowStandIn implements GeminiClient {
  chats: GeminiChatRequest[] = [];
  briefs: GeminiBriefRequest[] = [];
  delayMs = 0;
  briefDelayMs = 0;
  /** What every chat call answers unless a one-off answer is queued. */
  answer: string | ((req: GeminiChatRequest) => string) = JSON.stringify(TURN);
  private once: Array<string | Error> = [];
  briefAnswer: Error | null = null;
  /** One hook per brief call, in order: it may wait, and may throw. */
  briefHooks: Array<() => Promise<void>> = [];

  reset() {
    this.chats = [];
    this.briefs = [];
    this.delayMs = 0;
    this.briefDelayMs = 0;
    this.answer = JSON.stringify(TURN);
    this.once = [];
    this.briefAnswer = null;
    this.briefHooks = [];
  }
  queue(...a: Array<string | Error | Record<string, unknown>>) {
    for (const x of a) {
      this.once.push(
        typeof x === 'string' || x instanceof Error ? x : JSON.stringify(x),
      );
    }
  }
  async chat(req: GeminiChatRequest): Promise<string> {
    this.chats.push(req);
    if (this.delayMs) await sleep(this.delayMs);
    const next = this.once.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'string') return next;
    return typeof this.answer === 'function' ? this.answer(req) : this.answer;
  }
  async generateBrief(req: GeminiBriefRequest) {
    this.briefs.push(req);
    const hook = this.briefHooks.shift();
    if (hook) await hook();
    if (this.briefDelayMs) await sleep(this.briefDelayMs);
    if (this.briefAnswer) throw this.briefAnswer;
    return {
      summary: 'A tenant faces a mid-lease rent rise.',
      keyIssues: ['Whether the lease allows a rent review'],
      questionsToClarify: ['What does the review clause say?'],
      risks: [],
    };
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

/**
 * A throwaway WAWU ID account for a test that deletes or rewrites an
 * account's data. A per-run-unique email and phone keep the mock's
 * 409-on-taken from firing when the mock is reused across runs.
 */
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
      fullName: 'Legal Spec Throwaway',
      email: `legal-spec-${nonce}@test.wawu.dev`,
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

interface ThreadView {
  id: string;
  stage: string;
  messages: Array<{ authorRole: string; body: string }>;
  awaitingReply: boolean;
  legalRequestId: string | null;
}
interface Res {
  status: number;
  body: unknown;
}
const data = (res: Res) => (res.body as { data: ThreadView }).data;
const code = (res: Res) =>
  (res.body as { reason?: { code?: string } }).reason?.code;
const tally = (rs: Res[]) =>
  rs.reduce<Record<string, number>>((acc, r) => {
    const key = `${r.status}${code(r) ? `:${code(r)}` : ''}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

describe('Legal assistant under parallel requests (LEGAL-01 round 2, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let owned = false;
  let token: string;
  const ai = new SlowStandIn();

  const http = () => request(app.getHttpServer() as App);
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const start = async () =>
    data(
      await http().post('/api/hub/legal/assistant').set(as(token)).expect(201),
    );
  const say = (id: string, body: object): Promise<Res> =>
    http()
      .post(`/api/hub/legal/assistant/${id}/messages`)
      .set(as(token))
      .send(body)
      .then((r) => ({ status: r.status, body: r.body as unknown }));
  /** The older matter-chat route the web calls (after Send and payment). */
  const sayOld = (requestId: string, body: string): Promise<Res> =>
    http()
      .post(`/api/hub/legal/intake/chat/${requestId}`)
      .set(as(token))
      .send({ body })
      .then((r) => ({ status: r.status, body: r.body as unknown }));
  /** An intake sent to a consultant, its matter paid for. */
  const paidMatter = async () => {
    const t = await start();
    ai.queue(READY);
    await say(t.id, { body: 'My landlord raised my rent.' });
    const sent = data(await sendBrief(t.id));
    const requestId = sent.legalRequestId ?? '';
    await prisma.legalRequest.update({
      where: { id: requestId },
      data: { status: 'consultation_scheduled' },
    });
    return { t, requestId };
  };
  const reply = (id: string): Promise<Res> =>
    http()
      .post(`/api/hub/legal/assistant/${id}/reply`)
      .set(as(token))
      .then((r) => ({ status: r.status, body: r.body as unknown }));
  const sendBrief = (id: string): Promise<Res> =>
    http()
      .post(`/api/hub/legal/assistant/${id}/send`)
      .set(as(token))
      .then((r) => ({ status: r.status, body: r.body as unknown }));
  const par = <T>(n: number, f: (i: number) => Promise<T>) =>
    Promise.all(Array.from({ length: n }, (_, i) => f(i)));
  const clientCount = (id: string) =>
    prisma.legalIntakeMessage.count({
      where: { legalIntakeId: id, authorRole: 'client' },
    });
  const seedClient = (
    legalIntakeId: string,
    n: number,
    createdAt: Date,
    tag = 'old',
  ) =>
    prisma.legalIntakeMessage.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        legalIntakeId,
        wawuUserId: ME,
        authorRole: 'client' as const,
        body: `${tag}${i}`,
        createdAt: new Date(createdAt.getTime() + i),
      })),
    });
  /** What the hour's allowance has spent so far (messages and calls). */
  const spent = async () => {
    const since = new Date(Date.now() - HOUR);
    const requests = await prisma.legalRequest.findMany({
      where: { wawuUserId: ME },
      select: { id: true },
    });
    return (
      (await prisma.legalIntakeMessage.count({
        where: {
          wawuUserId: ME,
          authorRole: 'client',
          createdAt: { gte: since },
        },
      })) +
      (await prisma.legalAssistantCall.count({
        where: { wawuUserId: ME, createdAt: { gte: since } },
      })) +
      (await countedMatterMessages(
        requests.map((r) => r.id),
        since,
      ))
    );
  };
  /**
   * Client messages on matter threads that spent an AI call or could have:
   * every one except those written AFTER a consultant had written in the
   * same thread (those are for the consultant and are never counted).
   */
  const countedMatterMessages = async (requestIds: string[], since: Date) => {
    const rows = await prisma.legalChatMessage.findMany({
      where: {
        legalRequestId: { in: requestIds },
        authorRole: 'client',
        createdAt: { gte: since },
      },
      select: { legalRequestId: true, createdAt: true },
    });
    const joined = await prisma.legalChatMessage.groupBy({
      by: ['legalRequestId'],
      where: { legalRequestId: { in: requestIds }, authorRole: 'consultant' },
      _min: { createdAt: true },
    });
    const first = new Map(
      joined.map((j) => [j.legalRequestId, j._min.createdAt]),
    );
    return rows.filter((r) => {
      const at = first.get(r.legalRequestId);
      return !(at && at.getTime() < r.createdAt.getTime());
    }).length;
  };
  /** A consultant writing in a matter's thread (from the dashboard). */
  const consultantWrites = (requestId: string, body = 'I have your file.') =>
    prisma.legalChatMessage.create({
      data: { legalRequestId: requestId, authorRole: 'consultant', body },
    });
  const earlierIntake = () =>
    prisma.legalIntake.create({
      data: {
        wawuUserId: ME,
        matter: 'other',
        channel: 'assistant',
        status: 'converted',
      },
    });

  async function cleanUp() {
    const intakes = await prisma.legalIntake.findMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
      select: { legalRequestId: true },
    });
    const direct = await prisma.legalRequest.findMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
      select: { id: true },
    });
    const requestIds = [
      ...new Set([
        ...intakes
          .map((i) => i.legalRequestId)
          .filter((v): v is string => Boolean(v)),
        ...direct.map((r) => r.id),
      ]),
    ];
    await prisma.legalAssistantCall.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalIntakeMessage.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalIntake.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    if (requestIds.length > 0) {
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: requestIds } },
      });
    }
    await prisma.legalRequest.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      owned = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }
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
    // Listening once up front: sixty parallel requests must not each try to
    // open the server.
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);
    await cleanUp();
    token = await login(ME_EMAIL);
  }, 40000);

  afterEach(async () => {
    await cleanUp();
    ai.reset();
  });

  afterAll(async () => {
    if (prisma) await cleanUp();
    await app?.close();
    if (owned && mockWawuId) mockWawuId.kill();
  }, 30000);

  describe('D1: the message limits hold under parallel sends', () => {
    it(`60 parallel sends with a 150 ms provider accept exactly ${ASSISTANT_CLIENT_MESSAGES_PER_HOUR}`, async () => {
      const t = await start();
      ai.delayMs = 150;
      const rs = await par(60, (i) => say(t.id, { body: `p${i}` }));
      expect(tally(rs)).toEqual({
        '201': ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
        '429:assistant_rate_limited': 60 - ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
      });
      expect(await clientCount(t.id)).toBe(ASSISTANT_CLIENT_MESSAGES_PER_HOUR);
      expect(ai.chats).toHaveLength(ASSISTANT_CLIENT_MESSAGES_PER_HOUR);
    }, 60000);

    it(`${ASSISTANT_CLIENT_MESSAGES_PER_INTAKE - 4} old messages plus 20 parallel store exactly ${ASSISTANT_CLIENT_MESSAGES_PER_INTAKE}`, async () => {
      const t = await start();
      await seedClient(
        t.id,
        ASSISTANT_CLIENT_MESSAGES_PER_INTAKE - 4,
        new Date(Date.now() - 2 * HOUR),
      );
      ai.delayMs = 150;
      const rs = await par(20, (i) => say(t.id, { body: `q${i}` }));
      expect(tally(rs)).toEqual({
        '201': 4,
        '409:assistant_conversation_full': 16,
      });
      expect(await clientCount(t.id)).toBe(
        ASSISTANT_CLIENT_MESSAGES_PER_INTAKE,
      );
      expect(ai.chats).toHaveLength(4);
    }, 60000);

    it('the hourly count spans conversations: 25 recent elsewhere plus 20 parallel store 30 in the hour', async () => {
      const earlier = await earlierIntake();
      await seedClient(earlier.id, 25, new Date(Date.now() - 10 * 60_000));
      const t = await start();
      ai.delayMs = 150;
      const rs = await par(20, (i) => say(t.id, { body: `h${i}` }));
      expect(tally(rs)).toEqual({
        '201': ASSISTANT_CLIENT_MESSAGES_PER_HOUR - 25,
        '429:assistant_rate_limited':
          20 - (ASSISTANT_CLIENT_MESSAGES_PER_HOUR - 25),
      });
      const inHour = await prisma.legalIntakeMessage.count({
        where: {
          wawuUserId: ME,
          authorRole: 'client',
          createdAt: { gte: new Date(Date.now() - HOUR) },
        },
      });
      expect(inHour).toBe(ASSISTANT_CLIENT_MESSAGES_PER_HOUR);
    }, 60000);

    it('a refused send is not stored and calls no AI', async () => {
      const earlier = await earlierIntake();
      await seedClient(
        earlier.id,
        ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
        new Date(Date.now() - 10 * 60_000),
      );
      const t = await start();
      const r = await say(t.id, { body: 'no' });
      expect(r.status).toBe(429);
      expect(await clientCount(t.id)).toBe(0);
      expect(ai.chats).toHaveLength(0);
    });

    it('parallel sends in one conversation write one assistant reply to the newest message, not one each', async () => {
      const t = await start();
      ai.delayMs = 100;
      await par(6, (i) => say(t.id, { body: `d${i}` }));
      const rows = await prisma.legalIntakeMessage.findMany({
        where: { legalIntakeId: t.id, scripted: false },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(rows.filter((m) => m.authorRole === 'client')).toHaveLength(6);
      expect(rows.at(-1)?.authorRole).toBe('assistant');
      expect(rows.filter((m) => m.authorRole === 'assistant')).toHaveLength(1);
    }, 30000);
  });

  describe('D2: POST {id}/reply is limited and serialized', () => {
    async function waiting() {
      const t = await start();
      ai.queue(new Error('provider down'));
      await say(t.id, { body: 'hello' }).then((r) =>
        expect(r.status).toBe(503),
      );
      expect(ai.chats).toHaveLength(1);
      return t;
    }

    it('15 parallel replies against one waiting message make exactly one AI call; the rest are a clear 409', async () => {
      const t = await waiting();
      ai.delayMs = 150;
      const rs = await par(15, () => reply(t.id));
      const t2 = tally(rs);
      expect(t2['201']).toBe(1);
      expect(t2['409:assistant_busy']).toBeGreaterThanOrEqual(1);
      expect(
        Object.keys(t2).filter(
          (k) =>
            !['201', '409:assistant_busy', '409:nothing_to_answer'].includes(k),
        ),
      ).toEqual([]);
      expect(ai.chats).toHaveLength(2);
      const assistantRows = await prisma.legalIntakeMessage.count({
        where: {
          legalIntakeId: t.id,
          authorRole: 'assistant',
          scripted: false,
        },
      });
      expect(assistantRows).toBe(1);
    }, 30000);

    it('a reply counts toward the hourly limit: repeating it against a failing provider ends in 429', async () => {
      const earlier = await earlierIntake();
      await seedClient(
        earlier.id,
        ASSISTANT_CLIENT_MESSAGES_PER_HOUR - 3,
        new Date(Date.now() - 10 * 60_000),
      );
      const t = await waiting(); // the waiting message is the 28th of 30
      ai.answer = 'not json';
      const a = await reply(t.id);
      const b = await reply(t.id);
      const c = await reply(t.id);
      expect([a.status, b.status, c.status]).toEqual([503, 503, 429]);
      expect(code(c)).toBe('assistant_rate_limited');
      expect(ai.chats).toHaveLength(3);
      // A new message is refused too: replies used the allowance.
      expect((await say(t.id, { body: 'again' })).status).toBe(429);
    });
  });

  describe('D3: Send claims the intake before it asks the AI for the brief', () => {
    async function ready() {
      const t = await start();
      ai.queue(READY);
      await say(t.id, {
        body: 'My landlord raised my rent by 60 percent.',
      }).then((r) => expect(r.status).toBe(201));
      return t;
    }

    it('20 parallel sends make one brief call, one matter, and every caller sees the sent thread', async () => {
      const t = await ready();
      ai.briefDelayMs = 150;
      const rs = await par(20, () => sendBrief(t.id));
      expect(tally(rs)).toEqual({ '201': 20 });
      expect(ai.briefs).toHaveLength(1);
      expect(new Set(rs.map((r) => data(r).legalRequestId)).size).toBe(1);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(1);
      const sentLines = await prisma.legalIntakeMessage.count({
        where: {
          legalIntakeId: t.id,
          scripted: true,
          body: { contains: 'sent your brief' },
        },
      });
      expect(sentLines).toBe(1);
    }, 30000);

    it(`a failed brief can be sent again, up to ${ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR} tries an hour, then 429 with no AI call`, async () => {
      const t = await ready();
      ai.briefAnswer = new Error('provider down');
      const rs: Res[] = [];
      for (let i = 0; i < ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR; i++) {
        rs.push(await sendBrief(t.id));
      }
      expect(rs.map((r) => r.status)).toEqual(
        Array(ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR).fill(503),
      );
      const refused = await sendBrief(t.id);
      expect(refused.status).toBe(429);
      expect(code(refused)).toBe('assistant_rate_limited');
      expect(ai.briefs).toHaveLength(ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(0);
      // The allowance comes back with the hour, and the retry then works.
      await prisma.legalAssistantCall.updateMany({
        where: { wawuUserId: ME },
        data: { createdAt: new Date(Date.now() - 2 * HOUR) },
      });
      ai.briefAnswer = null;
      const ok = await sendBrief(t.id);
      expect(ok.status).toBe(201);
      expect(data(ok).stage).toBe('sent');
    });

    it('a failed parallel send releases the claim: 10 parallel sends against a failing provider make one call, and the next send works', async () => {
      const t = await ready();
      ai.briefDelayMs = 300;
      ai.briefAnswer = new Error('provider down');
      const rs = await par(10, () => sendBrief(t.id));
      expect(ai.briefs).toHaveLength(1);
      // The caller that held the claim is told the brief failed; the rest are
      // told the assistant was busy.
      expect(tally(rs)).toEqual({
        '503:assistant_unavailable': 1,
        '409:assistant_busy': 9,
      });
      ai.briefAnswer = null;
      expect((await sendBrief(t.id)).status).toBe(201);
    }, 30000);
  });

  describe('D4: characters Postgres rejects are a 400, never a 500', () => {
    it.each([
      ['a NUL', 'a\u0000b'],
      ['only a NUL', '\u0000'],
      ['a NUL after text', `${'x'.repeat(100)}\u0000`],
    ])(
      '%s in body is 400 message_invalid_characters, nothing stored, no AI call',
      async (_n, text) => {
        const t = await start();
        const r = await say(t.id, { body: text });
        expect(r.status).toBe(400);
        expect(code(r)).toBe('message_invalid_characters');
        expect(await clientCount(t.id)).toBe(0);
        expect(ai.chats).toHaveLength(0);
      },
    );

    it('a NUL in the assistant answer is dropped, not a 500', async () => {
      const t = await start();
      ai.queue({
        ...TURN,
        reply: 'Where is\u0000 the property?',
        headline: 'Ten\u0000ancy',
        facts: [{ label: 'Re\u0000nt', value: '60%\u0000' }],
      });
      const r = await say(t.id, { body: 'hello' });
      expect(r.status).toBe(201);
      const last = data(r).messages.at(-1);
      expect(last?.body).toBe('Where is the property?');
      expect(JSON.stringify(data(r))).not.toContain('\\u0000');
    });

    it('ordinary text with newlines, tabs, emoji and a lone surrogate is accepted', async () => {
      const t = await start();
      const r = await say(t.id, {
        body: 'line one\n\tline two \u{1F600} \ud800 end',
      });
      expect(r.status).toBe(201);
    });
  });

  describe('D5: opening is idempotent per person', () => {
    it('12 parallel opens give one in-progress assistant intake with two scripted lines', async () => {
      const rs = await par(12, () =>
        http()
          .post('/api/hub/legal/assistant')
          .set(as(token))
          .then((r) => ({ status: r.status, body: r.body as unknown })),
      );
      expect(tally(rs)).toEqual({ '201': 12 });
      expect(new Set(rs.map((r) => data(r).id)).size).toBe(1);
      const open = await prisma.legalIntake.findMany({
        where: { wawuUserId: ME, channel: 'assistant', status: 'in_progress' },
      });
      expect(open).toHaveLength(1);
      expect(
        await prisma.legalIntakeMessage.count({
          where: { legalIntakeId: open[0].id },
        }),
      ).toBe(2);
    }, 30000);

    it('the database itself refuses a second open assistant intake for one person', async () => {
      await start();
      await expect(
        prisma.legalIntake.create({
          data: { wawuUserId: ME, matter: 'other', channel: 'assistant' },
        }),
      ).rejects.toThrow();
      // Someone else, a converted one and a form intake are all fine.
      await prisma.legalIntake.create({
        data: { wawuUserId: OTHER, matter: 'other', channel: 'assistant' },
      });
      await earlierIntake();
      await prisma.legalIntake.create({
        data: { wawuUserId: ME, matter: 'other' },
      });
    });
  });

  describe('D6: no em-dash in anything the assistant says, paid wait included', () => {
    async function paid() {
      const t = await start();
      ai.queue(READY);
      await say(t.id, { body: 'My landlord raised my rent by 60 percent.' });
      const sent = data(await sendBrief(t.id));
      await prisma.legalRequest.update({
        where: { id: sent.legalRequestId ?? '' },
        data: { status: 'consultation_scheduled' },
      });
      return t;
    }

    it('a paid-wait reply loses its em-dashes in the response, in the thread and in storage', async () => {
      const t = await paid();
      ai.queue(
        'Thanks — your consultant will go through it — bring the lease.',
      );
      const r = await say(t.id, { body: 'What should I bring?' });
      expect(r.status).toBe(201);
      const body = data(r).messages.at(-1)?.body ?? '';
      expect(body).not.toContain('—');
      expect(body).toBe(
        'Thanks, your consultant will go through it, bring the lease.',
      );
      const again = data(
        await http().get(`/api/hub/legal/assistant/${t.id}`).set(as(token)),
      );
      expect(again.messages.map((m) => m.body).join('|')).not.toContain('—');
      const stored = await prisma.legalChatMessage.findMany({
        where: { legalRequestId: data(r).legalRequestId ?? '' },
      });
      expect(stored.map((m) => m.body).join('|')).not.toContain('—');
    });

    it('an assistant line stored with an em-dash before this fix is read without it', async () => {
      const t = await paid();
      await prisma.legalChatMessage.create({
        data: {
          legalRequestId:
            (
              await prisma.legalIntake.findUniqueOrThrow({
                where: { id: t.id },
              })
            ).legalRequestId ?? '',
          authorRole: 'ai',
          body: 'Old line — with a dash.',
        },
      });
      const again = data(
        await http().get(`/api/hub/legal/assistant/${t.id}`).set(as(token)),
      );
      expect(again.messages.at(-1)?.body).toBe('Old line, with a dash.');
    });
  });

  describe('D7: messages after Send are limited too', () => {
    it('before payment: 60 parallel messages store exactly what is left of the hourly allowance', async () => {
      const t = await start();
      ai.queue(READY);
      await say(t.id, { body: 'My landlord raised my rent.' });
      await sendBrief(t.id);
      const used = await spent();
      const rs = await par(60, (i) => say(t.id, { body: `after${i}` }));
      const left = ASSISTANT_CLIENT_MESSAGES_PER_HOUR - used;
      expect(tally(rs)).toEqual({
        '201': left,
        '429:assistant_rate_limited': 60 - left,
      });
      const request = await prisma.legalIntake.findUniqueOrThrow({
        where: { id: t.id },
      });
      expect(
        await prisma.legalChatMessage.count({
          where: {
            legalRequestId: request.legalRequestId ?? '',
            authorRole: 'client',
          },
        }),
      ).toBe(left);
      expect(ai.chats).toHaveLength(1);
    }, 60000);

    it('after payment: parallel messages are capped the same way and make one AI call each at most', async () => {
      const t = await start();
      ai.queue(READY);
      await say(t.id, { body: 'My landlord raised my rent.' });
      const sent = data(await sendBrief(t.id));
      await prisma.legalRequest.update({
        where: { id: sent.legalRequestId ?? '' },
        data: { status: 'consultation_scheduled' },
      });
      const before = ai.chats.length;
      ai.answer = 'Noted.';
      ai.delayMs = 150;
      const used = await spent();
      const rs = await par(60, (i) => say(t.id, { body: `paid${i}` }));
      const left = ASSISTANT_CLIENT_MESSAGES_PER_HOUR - used;
      expect(tally(rs)['201']).toBe(left);
      expect(ai.chats.length - before).toBe(left);
    }, 60000);

    it('the allowance is the same one: messages before and after Send add up', async () => {
      const earlier = await earlierIntake();
      await seedClient(
        earlier.id,
        ASSISTANT_CLIENT_MESSAGES_PER_HOUR - 1,
        new Date(Date.now() - 5 * 60_000),
      );
      const t = await start();
      ai.queue(READY);
      expect((await say(t.id, { body: 'the last one' })).status).toBe(201);
      await sendBrief(t.id);
      expect((await say(t.id, { body: 'one more' })).status).toBe(429);
    });
  });

  describe('D8: the older matter-chat route draws on the same allowance', () => {
    const storedClient = (requestId: string) =>
      prisma.legalChatMessage.count({
        where: { legalRequestId: requestId, authorRole: 'client' },
      });

    it('after payment, 100 parallel posts on /legal/intake/chat give at most the allowance in 201s and AI calls', async () => {
      const { requestId } = await paidMatter();
      const before = ai.chats.length;
      const left = 30 - (await spent());
      expect(left).toBeGreaterThan(0);
      ai.answer = 'Noted.';
      ai.delayMs = 150;
      const rs = await par(100, (i) => sayOld(requestId, `old${i}`));
      expect(tally(rs)).toEqual({
        '201': left,
        '429:assistant_rate_limited': 100 - left,
      });
      expect(ai.chats.length - before).toBe(left);
      expect(await storedClient(requestId)).toBe(left);
      const refused = rs.find((r) => r.status === 429) as Res;
      const reason = (
        refused.body as { reason: { retryAfterSeconds?: number } }
      ).reason;
      expect(reason.retryAfterSeconds).toBeGreaterThan(0);
      expect(reason.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }, 60000);

    it('old and new routes mixed share one allowance', async () => {
      const { t, requestId } = await paidMatter();
      const before = ai.chats.length;
      const left = 30 - (await spent());
      ai.answer = 'Noted.';
      ai.delayMs = 150;
      const rs = await par(100, (i) =>
        i % 2 === 0
          ? sayOld(requestId, `old${i}`)
          : say(t.id, { body: `new${i}` }),
      );
      expect(tally(rs)).toEqual({
        '201': left,
        '429:assistant_rate_limited': 100 - left,
      });
      expect(ai.chats.length - before).toBe(left);
      expect(await storedClient(requestId)).toBe(left);
      expect(await spent()).toBe(30);
    }, 60000);

    it('messages already counted on the new route use up the old route too, and the other way round', async () => {
      const { t, requestId } = await paidMatter();
      ai.answer = 'Noted.';
      const left = 30 - (await spent());
      for (let i = 0; i < left - 1; i++) {
        expect((await say(t.id, { body: `n${i}` })).status).toBe(201);
      }
      expect((await sayOld(requestId, 'the last one')).status).toBe(201);
      expect((await sayOld(requestId, 'one too many')).status).toBe(429);
      expect((await say(t.id, { body: 'and here' })).status).toBe(429);
    });

    it('under the limit the answer keeps its shape: the thread, as before', async () => {
      const { requestId } = await paidMatter();
      ai.answer = 'Noted.';
      const res = await sayOld(requestId, 'Here is the lease.');
      expect(res.status).toBe(201);
      const view = (
        res.body as {
          data: {
            legalRequestId: string;
            serviceName: string;
            status: string;
            consultantJoined: boolean;
            messages: Array<Record<string, unknown>>;
          };
        }
      ).data;
      expect(Object.keys(view).sort()).toEqual([
        'consultantJoined',
        'legalRequestId',
        'messages',
        'serviceName',
        'status',
      ]);
      expect(view.legalRequestId).toBe(requestId);
      expect(view.consultantJoined).toBe(false);
      const last = view.messages.slice(-2);
      expect(last.map((m) => m.authorRole)).toEqual(['client', 'ai']);
      expect(last[0].body).toBe('Here is the lease.');
      expect(Object.keys(last[1]).sort()).toEqual([
        'authorRole',
        'body',
        'createdAt',
        'id',
      ]);
    });

    it('before payment the route still refuses with 409, and counts nothing', async () => {
      const t = await start();
      ai.queue(READY);
      await say(t.id, { body: 'My landlord raised my rent.' });
      const sent = data(await sendBrief(t.id));
      const used = await spent();
      const res = await sayOld(sent.legalRequestId ?? '', 'too early');
      expect(res.status).toBe(409);
      expect(await spent()).toBe(used);
    });
  });

  describe('D9: once a consultant has written, the client is never counted or refused in that thread', () => {
    const storedClient = (requestId: string) =>
      prisma.legalChatMessage.count({
        where: { legalRequestId: requestId, authorRole: 'client' },
      });

    it('after a consultant has written, 40 sequential client messages on the old route are all 201, call no AI and are all stored', async () => {
      const { requestId } = await paidMatter();
      await consultantWrites(requestId);
      ai.answer = 'Noted.';
      const calls = ai.chats.length;
      const used = await spent();
      for (let i = 0; i < 40; i++) {
        const res = await sayOld(requestId, `to my consultant ${i}`);
        expect(res.status).toBe(201);
      }
      expect(ai.chats.length).toBe(calls);
      expect(await storedClient(requestId)).toBe(40);
      expect(await spent()).toBe(used);
    }, 60000);

    it('they do not use up the allowance: a later thread without a consultant still gets all that was left', async () => {
      const first = await paidMatter();
      await consultantWrites(first.requestId);
      ai.answer = 'Noted.';
      for (let i = 0; i < 40; i++) {
        expect((await sayOld(first.requestId, `c${i}`)).status).toBe(201);
      }
      // Two spent so far (the first message and the brief); the second
      // matter spends two more, so 26 of the 30 are left for its thread.
      const second = await paidMatter();
      expect(await spent()).toBe(4);
      ai.delayMs = 150;
      const before = ai.chats.length;
      const rs = await par(60, (i) => sayOld(second.requestId, `later${i}`));
      expect(tally(rs)).toEqual({
        '201': 26,
        '429:assistant_rate_limited': 34,
      });
      expect(ai.chats.length - before).toBe(26);
    }, 60000);

    it('messages written before the consultant still count; only the later ones are free', async () => {
      const { requestId } = await paidMatter();
      ai.answer = 'Noted.';
      for (let i = 0; i < 5; i++) {
        expect((await sayOld(requestId, `before${i}`)).status).toBe(201);
      }
      const used = await spent();
      expect(used).toBe(7);
      await consultantWrites(requestId);
      for (let i = 0; i < 40; i++) {
        expect((await sayOld(requestId, `after${i}`)).status).toBe(201);
      }
      expect(await spent()).toBe(7);
      expect(await storedClient(requestId)).toBe(45);
    }, 60000);

    it('the same holds on the assistant route after Send: 40 messages, all 201, no AI call', async () => {
      const { t, requestId } = await paidMatter();
      await consultantWrites(requestId);
      const calls = ai.chats.length;
      const used = await spent();
      for (let i = 0; i < 40; i++) {
        expect((await say(t.id, { body: `after send ${i}` })).status).toBe(201);
      }
      expect(ai.chats.length).toBe(calls);
      expect(await storedClient(requestId)).toBe(40);
      expect(await spent()).toBe(used);
    }, 60000);

    it('a person who is over the limit is still refused in a thread with no consultant, and free in the one with a consultant', async () => {
      const joined = await paidMatter();
      await consultantWrites(joined.requestId);
      const open = await paidMatter();
      ai.answer = 'Noted.';
      const left = 30 - (await spent());
      for (let i = 0; i < left; i++) {
        expect((await sayOld(open.requestId, `o${i}`)).status).toBe(201);
      }
      expect((await sayOld(open.requestId, 'one too many')).status).toBe(429);
      expect((await sayOld(joined.requestId, 'still free')).status).toBe(201);
      expect((await say(joined.t.id, { body: 'free here too' })).status).toBe(
        201,
      );
    }, 60000);

    it.each([0, 40, 100, 200])(
      'a consultant who writes while 50 client posts are in flight (after %i ms): no more AI calls than the allowance allows',
      async (afterMs) => {
        const { requestId } = await paidMatter();
        ai.answer = 'Noted.';
        ai.delayMs = 150;
        const before = ai.chats.length;
        const left = 30 - (await spent());
        // The consultant's line goes in through the service the dashboard
        // route calls, landing somewhere inside the batch.
        const consultant = (async () => {
          await sleep(afterMs);
          await app
            .get(LegalChatService)
            .sendAsConsultant(requestId, 'admin-race', 'Joining now.');
        })();
        const [rs] = await Promise.all([
          par(50, (i) => sayOld(requestId, `race${i}`)),
          consultant,
        ]);
        const t = tally(rs);
        const accepted = t['201'] ?? 0;
        expect(accepted + (t['429:assistant_rate_limited'] ?? 0)).toBe(50);
        expect(await storedClient(requestId)).toBe(accepted);

        const joined = await prisma.legalChatMessage.findFirstOrThrow({
          where: { legalRequestId: requestId, authorRole: 'consultant' },
        });
        const stored = await prisma.legalChatMessage.findMany({
          where: { legalRequestId: requestId, authorRole: 'client' },
          select: { createdAt: true },
        });
        const early = stored.filter(
          (m) => m.createdAt.getTime() < joined.createdAt.getTime(),
        ).length;
        // Everything stamped before the consultant was counted, so it fits
        // in what was left; everything after it was free (never a 429).
        expect(early).toBeLessThanOrEqual(left);
        expect(accepted).toBeGreaterThanOrEqual(early);
        expect(ai.chats.length - before).toBeLessThanOrEqual(early);
        expect(ai.chats.length - before).toBeLessThanOrEqual(left);
        expect(await spent()).toBeLessThanOrEqual(30);
        // A 429 only ever came before the consultant: once the handover
        // is in, the thread takes every message.
        const after = await sayOld(requestId, 'and one more');
        expect(after.status).toBe(201);
      },
      60000,
    );
  });

  describe('D9 (round 4 verifier): "has a consultant written" is asked of the whole thread, by both sides', () => {
    type Route = 'old' | 'new';
    const matterRow = (
      requestId: string,
      authorRole: 'client' | 'ai',
      body: string,
      createdAt: Date,
    ) => ({ legalRequestId: requestId, authorRole, body, createdAt });
    /** `rows` earlier lines (client, ai, client, ai ...), over an hour old so none is counted. */
    const seedThread = (requestId: string, rows: number) =>
      prisma.legalChatMessage.createMany({
        data: Array.from({ length: rows }, (_, i) =>
          matterRow(
            requestId,
            i % 2 === 0 ? 'client' : 'ai',
            `h${String(i).padStart(3, '0')}`,
            new Date(Date.now() - 3 * HOUR + i),
          ),
        ),
      });
    const post = (
      route: Route,
      m: { t: { id: string }; requestId: string },
      body: string,
    ) => (route === 'old' ? sayOld(m.requestId, body) : say(m.t.id, { body }));
    const aiAfterConsultant = async (requestId: string) => {
      const joined = await prisma.legalChatMessage.findFirstOrThrow({
        where: { legalRequestId: requestId, authorRole: 'consultant' },
      });
      return prisma.legalChatMessage.count({
        where: {
          legalRequestId: requestId,
          authorRole: 'ai',
          createdAt: { gt: joined.createdAt },
        },
      });
    };
    /** A matter at the paid stage straight in the database: it spends nothing of the allowance. */
    const bareMatter = () =>
      prisma.legalRequest.create({
        data: {
          wawuUserId: ME,
          serviceCode: 'tenancy-dispute',
          serviceName: 'Tenancy dispute',
          category: 'property',
          path: 'consultation',
          status: 'consultation_scheduled',
          details: { summary: 's' },
        },
      });

    describe.each<[Route, 'live' | 'seeded', number]>([
      ['old', 'live', 20],
      ['new', 'live', 20],
      ['old', 'seeded', 60],
      ['new', 'seeded', 60],
    ])('on the %s route, %s, %i earlier client messages', (route, how, n) => {
      it('after the consultant writes, 40 client posts are all 201 and the assistant answers none of them', async () => {
        const m = await paidMatter();
        ai.answer = 'Thanks. What is the lease length?';
        if (how === 'live') {
          for (let i = 0; i < n; i++) {
            expect((await post(route, m, `before ${i}`)).status).toBe(201);
          }
        } else {
          await seedThread(m.requestId, n * 2);
        }
        // The consultant's line will be the 41st row or later, past the 40
        // rows the assistant used to read.
        expect(
          await prisma.legalChatMessage.count({
            where: { legalRequestId: m.requestId },
          }),
        ).toBeGreaterThanOrEqual(40);
        await consultantWrites(m.requestId);
        const calls = ai.chats.length;
        const used = await spent();
        for (let i = 0; i < 40; i++) {
          expect((await post(route, m, `after ${i}`)).status).toBe(201);
        }
        expect(ai.chats.length).toBe(calls);
        expect(await aiAfterConsultant(m.requestId)).toBe(0);
        expect(await spent()).toBe(used);
      }, 90000);
    });

    it('100 parallel posts after the consultant, on a thread of 120 rows: all 201, no AI call', async () => {
      const m = await paidMatter();
      await seedThread(m.requestId, 120);
      await consultantWrites(m.requestId);
      ai.delayMs = 150;
      const calls = ai.chats.length;
      const rs = await par(100, (i) => sayOld(m.requestId, `p${i}`));
      expect(tally(rs)).toEqual({ '201': 100 });
      expect(ai.chats.length).toBe(calls);
      expect(await aiAfterConsultant(m.requestId)).toBe(0);
    }, 90000);

    it('the model is given the NEWEST 40 rows, oldest of them first', async () => {
      const m = await paidMatter();
      await seedThread(m.requestId, 60);
      ai.answer = 'Noted.';
      const calls = ai.chats.length;
      expect((await sayOld(m.requestId, 'the newest question')).status).toBe(
        201,
      );
      expect(ai.chats.length).toBe(calls + 1);
      const texts = ai.chats[calls].history.map((h) => h.text);
      expect(texts).toHaveLength(40);
      expect(texts.at(-1)).toBe('the newest question');
      // The 39 before it are the last 39 earlier rows (h021 to h059) in order.
      expect(texts.slice(0, 39)).toEqual(
        Array.from(
          { length: 39 },
          (_, i) => `h${String(21 + i).padStart(3, '0')}`,
        ),
      );
    }, 60000);

    it.each([0, 40, 100, 200])(
      'a consultant who writes (after %i ms) on a thread already past 40 rows while 50 posts are in flight: no more AI calls than were counted',
      async (afterMs) => {
        const { requestId } = await paidMatter();
        await seedThread(requestId, 90);
        ai.answer = 'Noted.';
        ai.delayMs = 150;
        const before = ai.chats.length;
        const left = 30 - (await spent());
        const consultant = (async () => {
          await sleep(afterMs);
          await app
            .get(LegalChatService)
            .sendAsConsultant(requestId, 'admin-race', 'Joining now.');
        })();
        const [rs] = await Promise.all([
          par(50, (i) => sayOld(requestId, `race${i}`)),
          consultant,
        ]);
        const t = tally(rs);
        expect((t['201'] ?? 0) + (t['429:assistant_rate_limited'] ?? 0)).toBe(
          50,
        );
        const joined = await prisma.legalChatMessage.findFirstOrThrow({
          where: { legalRequestId: requestId, authorRole: 'consultant' },
        });
        const early = await prisma.legalChatMessage.count({
          where: {
            legalRequestId: requestId,
            authorRole: 'client',
            createdAt: { lt: joined.createdAt },
            // the seeded history is not part of the race
            body: { startsWith: 'race' },
          },
        });
        expect(early).toBeLessThanOrEqual(left);
        // (An answer already on its way when the consultant wrote may land
        // after the consultant's line; it was counted, so it is in `early`.)
        expect(ai.chats.length - before).toBeLessThanOrEqual(early);
      },
      60000,
    );

    it('with two consultant lines, the client messages between them stay free (the FIRST line decides)', async () => {
      const a = await bareMatter();
      await consultantWrites(a.id, 'line one');
      for (let i = 0; i < 40; i++) {
        expect((await sayOld(a.id, `between ${i}`)).status).toBe(201);
      }
      await consultantWrites(a.id, 'line two');
      for (let i = 0; i < 5; i++) {
        expect((await sayOld(a.id, `after two ${i}`)).status).toBe(201);
      }
      // Nothing above was counted, so a fresh matter has the whole allowance.
      const b = await bareMatter();
      ai.delayMs = 150;
      const before = ai.chats.length;
      const rs = await par(40, (i) => sayOld(b.id, `fresh${i}`));
      expect(tally(rs)).toEqual({
        '201': ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
        '429:assistant_rate_limited': 40 - ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
      });
      expect(ai.chats.length - before).toBe(ASSISTANT_CLIENT_MESSAGES_PER_HOUR);
    }, 90000);

    it('the consultant write takes the client lock: held elsewhere, it waits, and so does a client post', async () => {
      const m = await paidMatter();
      const db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      let consultantDone = false;
      let clientDone = false;
      let consultantWrite: Promise<unknown> = Promise.resolve();
      let clientPost: Promise<unknown> = Promise.resolve();
      try {
        await db.query('BEGIN');
        await db.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`legal-assistant:${ME}`],
        );
        consultantWrite = app
          .get(LegalChatService)
          .sendAsConsultant(m.requestId, 'admin-lock', 'I have your file.')
          .then(() => {
            consultantDone = true;
          });
        clientPost = sayOld(m.requestId, 'control').then(() => {
          clientDone = true;
        });
        await sleep(1500);
        expect(clientDone).toBe(false);
        expect(consultantDone).toBe(false);
        expect(
          await prisma.legalChatMessage.count({
            where: { legalRequestId: m.requestId, authorRole: 'consultant' },
          }),
        ).toBe(0);
      } finally {
        await db.query('COMMIT').catch(() => undefined);
        await db.end();
      }
      await Promise.all([consultantWrite, clientPost]);
      expect(consultantDone).toBe(true);
      expect(clientDone).toBe(true);
    }, 30000);
  });

  describe('a release clears only its own lease', () => {
    const lease = async (id: string) =>
      (
        await prisma.legalIntake.findUniqueOrThrow({
          where: { id },
          select: { assistantBusyUntil: true },
        })
      ).assistantBusyUntil;

    async function ready() {
      const t = await start();
      ai.queue(READY);
      await say(t.id, {
        body: 'My landlord raised my rent by 60 percent.',
      }).then((r) => expect(r.status).toBe(201));
      return t;
    }

    it('a first holder that fails late does not free the second holder claim: no third call starts', async () => {
      const t = await ready();
      let failFirst: () => void = () => undefined;
      let finishSecond: () => void = () => undefined;
      ai.briefHooks = [
        // First holder: hangs, then fails after its lease has lapsed.
        () =>
          new Promise<void>((_, reject) => {
            failFirst = () => reject(new Error('provider timed out'));
          }),
        // Second holder: hangs until released, then succeeds.
        () =>
          new Promise<void>((resolve) => {
            finishSecond = resolve;
          }),
      ];

      const first = sendBrief(t.id);
      await waitFor(() => ai.briefs.length === 1);
      // Time passes: the first lease lapses (the claim is 60 s).
      await prisma.legalIntake.update({
        where: { id: t.id },
        data: { assistantBusyUntil: new Date(Date.now() - 1000) },
      });
      const second = sendBrief(t.id);
      await waitFor(() => ai.briefs.length === 2);
      const secondLease = await lease(t.id);
      expect(secondLease).not.toBeNull();
      expect(secondLease?.getTime()).toBeGreaterThan(Date.now());

      // The first call fails now. Its release must leave the second lease.
      failFirst();
      const firstRes = await first;
      expect(firstRes.status).toBe(503);
      expect(await lease(t.id)).toEqual(secondLease);

      // A third send does not start a call: the second holder still holds.
      const third = sendBrief(t.id);
      await sleep(300);
      expect(ai.briefs).toHaveLength(2);
      finishSecond();
      const [secondRes, thirdRes] = await Promise.all([second, third]);
      expect(secondRes.status).toBe(201);
      expect(thirdRes.status).toBe(201);
      expect(ai.briefs).toHaveLength(2);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(1);
    }, 30000);

    it('a holder that fails while its lease is still its own does free it', async () => {
      const t = await ready();
      ai.briefAnswer = new Error('provider down');
      expect((await sendBrief(t.id)).status).toBe(503);
      expect(await lease(t.id)).toBeNull();
      ai.briefAnswer = null;
      expect((await sendBrief(t.id)).status).toBe(201);
    });

    it('a lease that has lapsed lets the next holder in', async () => {
      const t = await ready();
      await prisma.legalIntake.update({
        where: { id: t.id },
        data: { assistantBusyUntil: new Date(Date.now() - 1000) },
      });
      expect((await sendBrief(t.id)).status).toBe(201);
      expect(ai.briefs).toHaveLength(1);
    });
  });

  describe('the limits are the numbers the brief names (literals, not the constants)', () => {
    it('the constants are 30 an hour, 40 a conversation and 5 brief tries', () => {
      expect(ASSISTANT_CLIENT_MESSAGES_PER_HOUR).toBe(30);
      expect(ASSISTANT_CLIENT_MESSAGES_PER_INTAKE).toBe(40);
      expect(ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR).toBe(5);
    });

    it('60 parallel sends: exactly 30 are accepted and 30 refused', async () => {
      const t = await start();
      ai.delayMs = 150;
      const rs = await par(60, (i) => say(t.id, { body: `p${i}` }));
      expect(tally(rs)).toEqual({
        '201': 30,
        '429:assistant_rate_limited': 30,
      });
      expect(await clientCount(t.id)).toBe(30);
      expect(ai.chats).toHaveLength(30);
    }, 60000);

    it('one conversation holds 40: 36 old plus 20 parallel store exactly 40', async () => {
      const t = await start();
      await seedClient(t.id, 36, new Date(Date.now() - 2 * HOUR));
      ai.delayMs = 150;
      const rs = await par(20, (i) => say(t.id, { body: `q${i}` }));
      expect(tally(rs)).toEqual({
        '201': 4,
        '409:assistant_conversation_full': 16,
      });
      expect(await clientCount(t.id)).toBe(40);
    }, 60000);

    it('a reply is held to the 40 as well', async () => {
      const t = await start();
      // Newer than the opening lines, so a client message is the one waiting.
      await seedClient(t.id, 40, new Date(Date.now() + 5_000));
      const res = await reply(t.id);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('assistant_conversation_full');
      expect(ai.chats).toHaveLength(0);
    });

    it('the brief is tried 5 times an hour: the 6th is a 429 with no AI call', async () => {
      const t = await start();
      ai.queue(READY);
      await say(t.id, { body: 'My landlord raised my rent.' });
      ai.briefAnswer = new Error('provider down');
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await sendBrief(t.id)).status);
      expect(statuses).toEqual([503, 503, 503, 503, 503, 429]);
      expect(ai.briefs).toHaveLength(5);
    });

    it('the hour is a full hour: 30 messages 45 minutes ago still count, 61 minutes ago do not', async () => {
      const earlier = await earlierIntake();
      await seedClient(earlier.id, 30, new Date(Date.now() - 45 * 60_000));
      const t = await start();
      const refused = await say(t.id, { body: 'too soon' });
      expect(refused.status).toBe(429);
      const retry = (refused.body as { reason: { retryAfterSeconds: number } })
        .reason.retryAfterSeconds;
      expect(retry).toBeGreaterThan(14 * 60);
      expect(retry).toBeLessThanOrEqual(15 * 60);

      await prisma.legalIntakeMessage.updateMany({
        where: { legalIntakeId: earlier.id },
        data: { createdAt: new Date(Date.now() - 61 * 60_000) },
      });
      expect((await say(t.id, { body: 'now fine' })).status).toBe(201);
    });
  });

  describe('M13: no message body ever reaches a log', () => {
    const lines: string[] = [];
    const sink: LoggerService = {
      log: (m: unknown, ...r: unknown[]) =>
        void lines.push(String(m), ...r.map(String)),
      error: (m: unknown, ...r: unknown[]) =>
        void lines.push(String(m), ...r.map(String)),
      warn: (m: unknown, ...r: unknown[]) =>
        void lines.push(String(m), ...r.map(String)),
      debug: (m: unknown, ...r: unknown[]) =>
        void lines.push(String(m), ...r.map(String)),
      verbose: (m: unknown, ...r: unknown[]) =>
        void lines.push(String(m), ...r.map(String)),
    };
    const spies: jest.SpyInstance[] = [];

    beforeAll(() => {
      Logger.overrideLogger(sink);
    });
    afterAll(() => {
      Logger.overrideLogger(['error', 'warn', 'log']);
    });
    beforeEach(() => {
      lines.length = 0;
      for (const k of ['log', 'error', 'warn', 'info', 'debug'] as const) {
        spies.push(
          jest.spyOn(console, k).mockImplementation((...a: unknown[]) => {
            lines.push(
              a
                .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
                .join(' '),
            );
          }),
        );
      }
    });
    afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

    it('holds through a good turn, a failed turn, a bad answer, a retry, a failed brief and a refusal', async () => {
      const SECRET = 'ZEBRA-7731-private-matter-text';
      const t = await start();
      ai.queue({ ...TURN, reply: `Reply ${SECRET}-reply` });
      await say(t.id, { body: `Good ${SECRET}` });
      ai.queue(new Error('provider down'));
      await say(t.id, { body: `Failing ${SECRET}` });
      ai.queue('not json at all');
      await reply(t.id);
      ai.queue(READY);
      await reply(t.id);
      ai.briefAnswer = new Error('brief provider down');
      await sendBrief(t.id);
      await say(t.id, { body: `Nul ${SECRET}\u0000` });
      await say(t.id, { body: '' });
      const earlier = await earlierIntake();
      await seedClient(
        earlier.id,
        ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
        new Date(Date.now() - 60_000),
      );
      await say(t.id, { body: `Limited ${SECRET}` });
      expect(lines.length).toBeGreaterThan(0); // the failures were logged
      expect(lines.join('\n')).not.toContain('ZEBRA');
      expect(lines.join('\n')).not.toContain(SECRET);
    }, 30000);
  });

  describe('the bookkeeping table is owned and purged with the account', () => {
    /**
     * The purge really deletes: the account's profile, content, comments and
     * everything else it owns. So it runs on a throwaway account this spec
     * registers for itself, never on a seeded one (purging the seeded creator
     * removes his content for every suite that runs after this one).
     */
    it('deleting an account removes its LegalAssistantCall rows', async () => {
      const own = await registerThrowawayIdentity();
      expect([ME, OTHER]).not.toContain(own.sub);
      const asOwn = as(own.accessToken);
      const ownCalls = () =>
        prisma.legalAssistantCall.count({ where: { wawuUserId: own.sub } });
      try {
        // A seeded account's call, to show the purge takes only its own.
        const mine = await start();
        ai.queue(READY);
        await say(mine.id, { body: 'My landlord raised my rent.' });
        await sendBrief(mine.id);
        expect(
          await prisma.legalAssistantCall.count({ where: { wawuUserId: ME } }),
        ).toBe(1);

        const t = data(
          await http().post('/api/hub/legal/assistant').set(asOwn).expect(201),
        );
        ai.queue(READY);
        await http()
          .post(`/api/hub/legal/assistant/${t.id}/messages`)
          .set(asOwn)
          .send({ body: 'My landlord raised my rent.' })
          .expect(201);
        await http()
          .post(`/api/hub/legal/assistant/${t.id}/send`)
          .set(asOwn)
          .expect(201);
        expect(await ownCalls()).toBe(1);

        const purge = await new AccountPurgeService(prisma).purge(own.sub);
        expect(purge.deleted['LegalAssistantCall.wawuUserId']).toBe(1);
        expect(await ownCalls()).toBe(0);
        // Nothing of the seeded account went with it.
        expect(
          await prisma.legalAssistantCall.count({ where: { wawuUserId: ME } }),
        ).toBe(1);
        expect(
          await prisma.legalIntake.count({ where: { wawuUserId: ME } }),
        ).toBe(1);
      } finally {
        // Idempotent: a failed run must not leave the throwaway's rows behind.
        await new AccountPurgeService(prisma).purge(own.sub);
      }
    });
  });
});
