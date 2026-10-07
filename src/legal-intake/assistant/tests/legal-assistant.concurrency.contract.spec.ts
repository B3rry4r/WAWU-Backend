// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
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

  reset() {
    this.chats = [];
    this.briefs = [];
    this.delayMs = 0;
    this.briefDelayMs = 0;
    this.answer = JSON.stringify(TURN);
    this.once = [];
    this.briefAnswer = null;
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
      (await prisma.legalChatMessage.count({
        where: {
          legalRequestId: { in: requests.map((r) => r.id) },
          authorRole: 'client',
          createdAt: { gte: since },
        },
      }))
    );
  };
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
    const requestIds = intakes
      .map((i) => i.legalRequestId)
      .filter((v): v is string => Boolean(v));
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
    it('deleting an account removes its LegalAssistantCall rows', async () => {
      const t = await start();
      ai.queue(READY);
      await say(t.id, { body: 'My landlord raised my rent.' });
      await sendBrief(t.id);
      expect(
        await prisma.legalAssistantCall.count({ where: { wawuUserId: ME } }),
      ).toBe(1);
      const purge = await new AccountPurgeService(prisma).purge(ME);
      expect(purge.deleted['LegalAssistantCall.wawuUserId']).toBe(1);
      expect(
        await prisma.legalAssistantCall.count({ where: { wawuUserId: ME } }),
      ).toBe(0);
    });
  });
});
