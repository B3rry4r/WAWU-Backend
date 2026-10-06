// Run against a test database, always via `npm run test:contract`.
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
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  seedAdminFixtures,
  type AdminTokens,
} from '../../../common/tests/admin-session.helper';
import { LegalIntakeModule } from '../../legal-intake.module';
import {
  ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES,
  ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
  ASSISTANT_CLIENT_MESSAGES_PER_INTAKE,
} from '../legal-assistant-config';
import { NOT_CHARGED_LINE, SENT_LINE } from '../legal-assistant.service';

/**
 * Legal starts as a chat (LEGAL-01).
 *
 * The AI provider is a STAND-IN here: GEMINI_CLIENT is overridden with a
 * scripted client that records every request, so no test ever calls a real
 * model, needs a key, or asserts against what a model happened to say. The
 * records are also how the suite proves what is (and is not) sent to the
 * provider.
 *
 * Envelope note: ResponseInterceptor puts a plain result in `data`.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// creator-basic in mock-wawu-id: Chidi Umeh. creator-pro is "someone else".
const ME = '00000000-0000-4000-8000-000000000002';
const ME_EMAIL = 'creator-basic@test.wawu.dev';
const ME_FIRST_NAME = 'Chidi';
const ME_LAST_NAME = 'Umeh';
const ME_PHONE_TAIL = '000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

const ADMINS = adminFixtures('1e9a0000', 'legal-assistant');
const SECRETS = adminJwtSecrets('legal-assistant');

/** The scripted provider. Every request is kept for the privacy checks. */
class StandInGemini implements GeminiClient {
  chats: GeminiChatRequest[] = [];
  briefs: GeminiBriefRequest[] = [];
  private chatAnswers: Array<string | Error> = [];
  briefAnswer: { summary: string } | Error = {
    summary: 'A tenant faces a mid-lease rent rise.',
  };

  queue(...answers: Array<string | Error | Record<string, unknown>>) {
    for (const a of answers) {
      this.chatAnswers.push(
        typeof a === 'string' || a instanceof Error ? a : JSON.stringify(a),
      );
    }
  }

  reset() {
    this.chats = [];
    this.briefs = [];
    this.chatAnswers = [];
    this.briefAnswer = { summary: 'A tenant faces a mid-lease rent rise.' };
  }

  chat(req: GeminiChatRequest): Promise<string> {
    this.chats.push(req);
    const next = this.chatAnswers.shift();
    if (next === undefined) {
      return Promise.reject(new Error('stand-in has no answer queued'));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  generateBrief(req: GeminiBriefRequest) {
    this.briefs.push(req);
    if (this.briefAnswer instanceof Error) {
      return Promise.reject(this.briefAnswer);
    }
    return Promise.resolve({
      summary: this.briefAnswer.summary,
      keyIssues: ['Whether the lease allows a rent review'],
      questionsToClarify: ['What does the review clause say?'],
      risks: [],
    });
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
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const QUESTION = {
  reply: 'Got it. Is the lease written and signed, and how long is left on it?',
  quickReplies: [],
  matter: 'property',
  headline: 'Tenancy · rent increase',
  facts: [{ label: 'Rent rise', value: '60% mid-lease' }],
  answers: { property_role: 'tenant' },
  briefReady: false,
};
const REVIEW_QUESTION = {
  reply: 'Does the lease say anything about rent reviews?',
  quickReplies: ["Yes, there's a clause", 'No', "I'm not sure"],
  matter: 'property',
  headline: 'Tenancy · rent increase',
  facts: [
    { label: 'Rent rise', value: '60% mid-lease' },
    { label: 'Lease', value: 'Signed, 14 months left' },
  ],
  answers: {},
  briefReady: false,
};
const READY = {
  reply: "Thanks. Here's what I'll pass on. Check it's right.",
  quickReplies: [],
  matter: 'property',
  headline: 'Tenancy · rent increase',
  facts: [
    { label: 'Lease', value: 'Signed, 14 months left' },
    { label: 'Rent review clause', value: 'Not sure' },
    { label: 'Location', value: 'Lekki, Lagos' },
  ],
  answers: {},
  briefReady: true,
};

interface ThreadView {
  id: string;
  stage: string;
  matter: string;
  messages: Array<{
    authorRole: string;
    body: string;
    consultantName: string | null;
  }>;
  quickReplies: Array<{ id: string; label: string }>;
  brief: null | {
    matter: string;
    matterLabel: string;
    rows: Array<{ label: string; value: string }>;
    ready: boolean;
  };
  awaitingReply: boolean;
  legalRequestId: string | null;
  requestStatus: string | null;
  consultant: null | { name: string | null; joinedAt: string };
  assistantStopped: boolean;
}

interface Refusal {
  message: string;
  reason?: { code: string; retryAfterSeconds?: number };
}

/** The success envelope's payload, typed. */
function data<T = ThreadView>(res: { body: unknown }): T {
  return (res.body as { data: T }).data;
}

/** A refusal's body, typed. */
function refused(res: { body: unknown }): Refusal {
  return res.body as Refusal;
}

describe('Legal assistant: legal starts as a chat (LEGAL-01, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let owned = false;
  let token: string;
  let otherToken: string;
  let admins: AdminTokens;
  const gemini = new StandInGemini();
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer() as App);
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function cleanUp() {
    const intakes = await prisma.legalIntake.findMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
      select: { id: true, legalRequestId: true },
    });
    const requestIds = intakes
      .map((i) => i.legalRequestId)
      .filter((v): v is string => Boolean(v));
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
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;

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
      .useValue(gemini)
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

    prisma = moduleRef.get(PrismaService);
    await cleanUp();
    await seedAdminFixtures(prisma, ADMINS);
    token = await login(ME_EMAIL);
    otherToken = await login('creator-pro@test.wawu.dev');
    admins = await loginAllAdmins(app, ADMINS);
  }, 40000);

  afterEach(async () => {
    await cleanUp();
    gemini.reset();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanUp();
      await deleteAdminFixtures(prisma, ADMINS);
    }
    await app?.close();
    if (owned && mockWawuId) mockWawuId.kill();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 30000);

  const start = async (t = token) => {
    const res = await http()
      .post('/api/hub/legal/assistant')
      .set(as(t))
      .expect(201);
    return data(res);
  };
  const say = (id: string, body: object, t = token) =>
    http()
      .post(`/api/hub/legal/assistant/${id}/messages`)
      .set(as(t))
      .send(body);

  /** Through the design's S14 to S16: a topic, two answers, the brief. */
  async function profileToBrief() {
    const thread = await start();
    gemini.queue(QUESTION, QUESTION, REVIEW_QUESTION, READY);
    await say(thread.id, { quickReplyId: 'topic:property' }).expect(201);
    await say(thread.id, {
      body: 'My landlord wants to raise my rent by 60% mid-lease. Can he do that?',
    }).expect(201);
    const s15 = await say(thread.id, {
      body: 'Signed, 2 years. 14 months left.',
    }).expect(201);
    const notSure = data(s15).quickReplies.find(
      (q: { label: string }) => q.label === "I'm not sure",
    );
    const s16 = await say(thread.id, { quickReplyId: notSure?.id }).expect(201);
    return { id: thread.id, s15: data(s15), s16: data(s16) };
  }

  describe('opening (S14)', () => {
    it('refuses without a WAWU ID token', async () => {
      await http().get('/api/hub/legal/assistant/topics').expect(401);
      await http().post('/api/hub/legal/assistant').expect(401);
    });

    it('serves the topic taps as a named list, each mapped to an intake matter', async () => {
      const res = await http()
        .get('/api/hub/legal/assistant/topics')
        .set(as(token))
        .expect(200);
      expect(data(res)).toEqual([
        {
          id: 'topic:property',
          label: 'A tenancy problem',
          matter: 'property',
          matterLabel: 'Property',
        },
        {
          id: 'topic:business_registration',
          label: 'Register a business',
          matter: 'business_registration',
          matterLabel: 'Business registration',
        },
        {
          id: 'topic:contract',
          label: 'Check a contract',
          matter: 'contract',
          matterLabel: 'Contract drafting or review',
        },
        {
          id: 'topic:other',
          label: 'Something else',
          matter: 'other',
          matterLabel: 'Something else',
        },
      ]);
    });

    it('opens with the two lines and the topic taps, without calling the AI or charging anything', async () => {
      const thread = await start();
      expect(thread.stage).toBe('profiling');
      expect(thread.messages.map((m) => [m.authorRole, m.body])).toEqual([
        [
          'assistant',
          `Hi ${ME_FIRST_NAME}. Tell me what's going on, in your own words. I'll ask a few questions, then a consultant picks it up.`,
        ],
        ['assistant', NOT_CHARGED_LINE],
      ]);
      expect(thread.quickReplies.map((q) => q.label)).toEqual([
        'A tenancy problem',
        'Register a business',
        'Check a contract',
        'Something else',
      ]);
      expect(thread).toMatchObject({
        brief: null,
        legalRequestId: null,
        consultant: null,
        assistantStopped: false,
        awaitingReply: false,
      });
      expect(gemini.chats).toHaveLength(0);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(0);
    });

    it('picks the unfinished conversation back up instead of opening a second one', async () => {
      const first = await start();
      const again = await start();
      expect(again.id).toBe(first.id);
      expect(
        await prisma.legalIntake.count({ where: { wawuUserId: ME } }),
      ).toBe(1);
    });

    it("the web's question form never resumes an assistant conversation", async () => {
      const thread = await start();
      await say(thread.id, { quickReplyId: 'topic:property' });
      const form = await http()
        .post('/api/hub/legal/intake')
        .set(as(token))
        .send({ matter: 'property' })
        .expect(201);
      expect(data(form).id).not.toBe(thread.id);
    });
  });

  describe('capability 1: a user can describe a problem and receive a brief without paying', () => {
    it('S14 to S16: a topic tap, typed answers and a quick reply end in a brief card, then Send to a consultant', async () => {
      const { id, s15, s16 } = await profileToBrief();

      expect(s15.stage).toBe('profiling');
      expect(s15.matter).toBe('property');
      expect(
        s15.messages
          .slice(2)
          .map((m: { authorRole: string; body: string }) => [
            m.authorRole,
            m.body,
          ]),
      ).toEqual([
        ['client', 'A tenancy problem'],
        ['assistant', QUESTION.reply],
        [
          'client',
          'My landlord wants to raise my rent by 60% mid-lease. Can he do that?',
        ],
        ['assistant', QUESTION.reply],
        ['client', 'Signed, 2 years. 14 months left.'],
        ['assistant', REVIEW_QUESTION.reply],
      ]);
      expect(s15.quickReplies.map((q: { label: string }) => q.label)).toEqual(
        REVIEW_QUESTION.quickReplies,
      );

      expect(s16.stage).toBe('brief_ready');
      expect(s16.quickReplies).toEqual([]);
      expect(s16.brief).toEqual({
        matter: 'property',
        matterLabel: 'Property',
        rows: [
          { label: 'Matter', value: 'Tenancy · rent increase' },
          { label: 'Lease', value: 'Signed, 14 months left' },
          { label: 'Rent review clause', value: 'Not sure' },
          { label: 'Location', value: 'Lekki, Lagos' },
        ],
        ready: true,
      });
      // The brief is written into the intake while the conversation runs.
      const draft = await prisma.legalIntake.findUniqueOrThrow({
        where: { id },
      });
      expect(draft.draftBrief).toMatchObject({
        ready: true,
        headline: 'Tenancy · rent increase',
      });
      expect(draft.answers).toEqual({ property_role: 'tenant' });

      const sent = await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(201);
      const thread = data(sent);
      expect(thread.stage).toBe('sent');
      expect(thread.requestStatus).toBe('awaiting_quote');
      expect(thread.messages[thread.messages.length - 1]).toMatchObject({
        authorRole: 'assistant',
        body: SENT_LINE,
      });
      expect(thread.brief?.rows).toEqual(s16.brief?.rows);

      // Nothing paid, nothing priced: the matter waits for a consultant.
      const matter = await prisma.legalRequest.findUniqueOrThrow({
        where: { id: thread.legalRequestId ?? '' },
      });
      expect(matter).toMatchObject({
        wawuUserId: ME,
        status: 'awaiting_quote',
        serviceCode: 'property-documentation',
        consultationFee: null,
        consultationPaidAt: null,
        consultationTxRef: null,
        quoteAmount: null,
      });
      const intake = await prisma.legalIntake.findUniqueOrThrow({
        where: { id },
      });
      expect(intake.status).toBe('converted');
      expect(intake.legalRequestId).toBe(matter.id);
      expect((intake.brief as { facts: unknown }).facts).toEqual([
        { question: 'Matter', answer: 'Tenancy · rent increase' },
        { question: 'Lease', answer: 'Signed, 14 months left' },
        { question: 'Rent review clause', answer: 'Not sure' },
        { question: 'Location', answer: 'Lekki, Lagos' },
      ]);
      expect(
        (intake.brief as { analysis: { summary: string } }).analysis.summary,
      ).toBe('A tenant faces a mid-lease rent rise.');
      expect((matter.details as { intakeId: string }).intakeId).toBe(id);
    });

    it('sending twice opens one matter', async () => {
      const { id } = await profileToBrief();
      const [a, b] = await Promise.all([
        http().post(`/api/hub/legal/assistant/${id}/send`).set(as(token)),
        http().post(`/api/hub/legal/assistant/${id}/send`).set(as(token)),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(1);
      expect(data(a).legalRequestId).toBe(data(b).legalRequestId);
      const again = await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(201);
      expect(data(again).legalRequestId).toBe(data(a).legalRequestId);
      expect(
        await prisma.legalIntakeMessage.count({
          where: { legalIntakeId: id, body: SENT_LINE },
        }),
      ).toBe(1);
    });

    it('refuses to send before the brief is ready (409 brief_not_ready)', async () => {
      const thread = await start();
      gemini.queue(QUESTION);
      await say(thread.id, {
        body: 'My landlord wants to raise my rent.',
      }).expect(201);
      const res = await http()
        .post(`/api/hub/legal/assistant/${thread.id}/send`)
        .set(as(token))
        .expect(409);
      expect(refused(res).reason?.code).toBe('brief_not_ready');
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(0);
    });

    it('a failed brief analysis sends nothing (503) and the brief can be sent again', async () => {
      const { id } = await profileToBrief();
      gemini.briefAnswer = new Error('provider down');
      const res = await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(503);
      expect(refused(res).reason?.code).toBe('assistant_unavailable');
      expect(refused(res).message).not.toMatch(/—/);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(0);
      gemini.briefAnswer = { summary: 'Second try.' };
      await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(201);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(1);
    });

    it('the brief is offered after enough answers even if the assistant keeps asking', async () => {
      const thread = await start();
      const asking = { ...QUESTION, briefReady: false };
      for (let i = 0; i < ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES; i++)
        gemini.queue(asking);
      let stage = '';
      for (let i = 0; i < ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES; i++) {
        stage = data(
          await say(thread.id, { body: `Answer ${i + 1}` }).expect(201),
        ).stage;
        if (i < ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES - 1)
          expect(stage).toBe('profiling');
      }
      expect(stage).toBe('brief_ready');
    });
  });

  describe('what reaches the AI provider (minimum personal data)', () => {
    it('never the name, email, phone or ids; never the scripted lines; never the gender question', async () => {
      const { id } = await profileToBrief();
      await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(201);
      const sent = JSON.stringify({
        chats: gemini.chats,
        briefs: gemini.briefs,
      });
      for (const secret of [
        ME_FIRST_NAME,
        ME_LAST_NAME,
        ME_EMAIL,
        ME_PHONE_TAIL,
        ME,
        id,
        NOT_CHARGED_LINE,
        SENT_LINE,
      ]) {
        expect(sent).not.toContain(secret);
      }
      expect(sent).not.toMatch(/gender/i);
      expect(gemini.chats).toHaveLength(4);
      // What a turn carries: the instruction and the conversation, starting
      // with the client.
      const lastTurn = gemini.chats[3];
      expect(lastTurn.history[0]).toEqual({
        role: 'user',
        text: 'A tenancy problem',
      });
      expect(lastTurn.history.map((h) => h.role)).toEqual([
        'user',
        'model',
        'user',
        'model',
        'user',
        'model',
        'user',
      ]);
      expect(lastTurn.instruction).toContain('The matter so far: property');
      // The brief analysis is written from the confirmed rows only.
      expect(gemini.briefs).toHaveLength(1);
      expect(gemini.briefs[0].content).toContain(
        'Lease\n  Signed, 14 months left',
      );
      expect(gemini.briefs[0].content).not.toContain('landlord wants');
    });

    it('keeps only answers the matter accepts: no gender, no unknown id, no made-up option; em-dashes removed', async () => {
      const thread = await start();
      gemini.queue({
        ...QUESTION,
        reply: 'Got it — is the lease signed?',
        facts: [{ label: 'Rent rise', value: '60% — mid-lease' }],
        answers: {
          property_role: 'tenant',
          gender: 'female',
          urgency: 'yesterday',
          made_up: 'x',
          description: 'Rent rise of 60%',
        },
      });
      const res = await say(thread.id, {
        quickReplyId: 'topic:property',
      }).expect(201);
      const intake = await prisma.legalIntake.findUniqueOrThrow({
        where: { id: thread.id },
      });
      expect(intake.answers).toEqual({
        property_role: 'tenant',
        description: 'Rent rise of 60%',
      });
      const reply = data(res).messages[data(res).messages.length - 1].body;
      expect(reply).toBe('Got it, is the lease signed?');
      expect(JSON.stringify(data(res))).not.toMatch(/—/);
    });

    it('a model answer wrapped in a code fence is still read; one with no JSON is a 503', async () => {
      const thread = await start();
      gemini.queue(
        '```json\n' + JSON.stringify(QUESTION) + '\n```',
        'I am not JSON at all',
      );
      await say(thread.id, { body: 'Rent rise' }).expect(201);
      const res = await say(thread.id, { body: 'More' }).expect(503);
      expect(refused(res).reason?.code).toBe('assistant_unavailable');
    });
  });

  describe('when the assistant cannot answer', () => {
    it('keeps the message (503 assistant_unavailable), shows it is waiting, and answers on retry', async () => {
      const thread = await start();
      gemini.queue(new Error('provider down'));
      const failed = await say(thread.id, {
        body: 'My landlord wants more rent.',
      }).expect(503);
      expect(refused(failed).reason?.code).toBe('assistant_unavailable');
      expect(refused(failed).message).toBe(
        'Your message was saved. The assistant could not reply just now. Try again in a moment.',
      );

      const waiting = await http()
        .get(`/api/hub/legal/assistant/${thread.id}`)
        .set(as(token))
        .expect(200);
      expect(data(waiting).awaitingReply).toBe(true);
      expect(data(waiting).quickReplies).toEqual([]);
      expect(data(waiting).messages.at(-1)).toMatchObject({
        authorRole: 'client',
        body: 'My landlord wants more rent.',
      });

      gemini.queue(QUESTION);
      const retried = await http()
        .post(`/api/hub/legal/assistant/${thread.id}/reply`)
        .set(as(token))
        .expect(201);
      expect(data(retried).awaitingReply).toBe(false);
      expect(data(retried).messages.at(-1)?.body).toBe(QUESTION.reply);

      const nothing = await http()
        .post(`/api/hub/legal/assistant/${thread.id}/reply`)
        .set(as(token))
        .expect(409);
      expect(refused(nothing).reason?.code).toBe('nothing_to_answer');
    });
  });

  describe('refusals', () => {
    it('400 message_empty for neither or both of body and quickReplyId', async () => {
      const thread = await start();
      for (const body of [
        {},
        { body: '   ' },
        { body: 'hi', quickReplyId: 'topic:other' },
      ]) {
        const res = await say(thread.id, body).expect(400);
        expect(refused(res).reason?.code).toBe('message_empty');
      }
      const long = await say(thread.id, { body: 'x'.repeat(2001) }).expect(400);
      expect(refused(long).reason).toBeUndefined();
    });

    it('400 quick_reply_unknown for a tap that is not on offer', async () => {
      const thread = await start();
      gemini.queue(QUESTION);
      await say(thread.id, { quickReplyId: 'topic:property' }).expect(201);
      // The topics were the opener's taps; they are no longer live.
      const res = await say(thread.id, {
        quickReplyId: 'topic:contract',
      }).expect(400);
      expect(refused(res).reason?.code).toBe('quick_reply_unknown');
    });

    it("404 for someone else's conversation, an unknown id, or a form intake", async () => {
      const mine = await start();
      for (const t of [otherToken]) {
        const res = await http()
          .get(`/api/hub/legal/assistant/${mine.id}`)
          .set(as(t))
          .expect(404);
        expect(refused(res).reason?.code).toBe('not_found');
        await say(mine.id, { body: 'hello' }, t).expect(404);
        await http()
          .post(`/api/hub/legal/assistant/${mine.id}/send`)
          .set(as(t))
          .expect(404);
      }
      await http()
        .get(`/api/hub/legal/assistant/${crypto.randomUUID()}`)
        .set(as(token))
        .expect(404);
      const form = await http()
        .post('/api/hub/legal/intake')
        .set(as(token))
        .send({ matter: 'tax' })
        .expect(201);
      await http()
        .get(`/api/hub/legal/assistant/${data(form).id}`)
        .set(as(token))
        .expect(404);
      await http()
        .get('/api/hub/legal/assistant/not-a-uuid')
        .set(as(token))
        .expect(400);
    });

    it(`409 assistant_conversation_full after ${ASSISTANT_CLIENT_MESSAGES_PER_INTAKE} client messages`, async () => {
      const thread = await start();
      const old = new Date(Date.now() - 2 * 3_600_000);
      await prisma.legalIntakeMessage.createMany({
        data: Array.from(
          { length: ASSISTANT_CLIENT_MESSAGES_PER_INTAKE },
          (_, i) => ({
            legalIntakeId: thread.id,
            wawuUserId: ME,
            authorRole: 'client' as const,
            body: `m${i}`,
            createdAt: old,
          }),
        ),
      });
      const res = await say(thread.id, { body: 'one more' }).expect(409);
      expect(refused(res).reason?.code).toBe('assistant_conversation_full');
      expect(gemini.chats).toHaveLength(0);
    });

    it(`429 assistant_rate_limited after ${ASSISTANT_CLIENT_MESSAGES_PER_HOUR} client messages in an hour, counted per person`, async () => {
      const thread = await start();
      const earlier = await prisma.legalIntake.create({
        data: {
          wawuUserId: ME,
          matter: 'other',
          channel: 'assistant',
          status: 'converted',
        },
      });
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
      await prisma.legalIntakeMessage.createMany({
        data: Array.from(
          { length: ASSISTANT_CLIENT_MESSAGES_PER_HOUR },
          (_, i) => ({
            legalIntakeId: earlier.id,
            wawuUserId: ME,
            authorRole: 'client' as const,
            body: `m${i}`,
            createdAt: tenMinutesAgo,
          }),
        ),
      });
      const res = await say(thread.id, { body: 'hello' }).expect(429);
      expect(refused(res).reason?.code).toBe('assistant_rate_limited');
      expect(refused(res).reason?.retryAfterSeconds).toBeGreaterThan(49 * 60);
      expect(refused(res).reason?.retryAfterSeconds).toBeLessThanOrEqual(
        50 * 60,
      );
      expect(gemini.chats).toHaveLength(0);
      // Someone else is not affected.
      const theirs = await start(otherToken);
      gemini.queue(QUESTION);
      await say(theirs.id, { body: 'hello' }, otherToken).expect(201);
    });
  });

  describe('capability 2: a consultant joins and sees the brief before any payment', () => {
    it('reads the queue, the brief and the conversation, joins, and the assistant stops (S17)', async () => {
      const { id } = await profileToBrief();
      const sent = data(
        await http()
          .post(`/api/hub/legal/assistant/${id}/send`)
          .set(as(token))
          .expect(201),
      );
      const requestId = sent.legalRequestId as string;

      // The intake queue and detail: the brief, with nothing paid.
      const queue = await http()
        .get('/api/hub/legal/ops/intakes/queue')
        .set(bearer(admins.support))
        .expect(200);
      const row = data<Array<{ id: string }>>(queue).find((r) => r.id === id);
      expect(row).toMatchObject({
        matter: 'property',
        status: 'converted',
        summary: 'A tenant faces a mid-lease rent rise.',
      });
      const detail = await http()
        .get(`/api/hub/legal/ops/intakes/${id}`)
        .set(bearer(admins.support))
        .expect(200);
      expect(data(detail).legalRequestId).toBe(requestId);
      expect(
        data<{ brief: { facts: unknown[] } }>(detail).brief.facts,
      ).toContainEqual({
        question: 'Rent review clause',
        answer: 'Not sure',
      });
      const matter = await prisma.legalRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(matter.consultationPaidAt).toBeNull();
      expect(matter.servicePaidAt).toBeNull();

      // What the assistant and the client said before sending.
      const transcript = await http()
        .get(`/api/hub/legal/ops/intakes/${id}/assistant`)
        .set(bearer(admins.support))
        .expect(200);
      expect(data(transcript).legalRequestId).toBe(requestId);
      expect(
        data(transcript).messages.map((m: { body: string }) => m.body),
      ).toContain('Signed, 2 years. 14 months left.');
      expect(data(transcript).brief?.rows[0]).toEqual({
        label: 'Matter',
        value: 'Tenancy · rent increase',
      });

      // The consultant joins on the matter's thread, before any payment.
      await http()
        .post(`/api/hub/legal/ops/intakes/chat/${requestId}`)
        .set(bearer(admins.support))
        .send({
          body: "Hi Chidi, I've read your brief. Let's look at the lease together.",
        })
        .expect(201);

      const s17 = data(
        await http()
          .get(`/api/hub/legal/assistant/${id}`)
          .set(as(token))
          .expect(200),
      );
      expect(s17.consultant).toMatchObject({ name: 'legal-assistant support' });
      expect(s17.assistantStopped).toBe(true);
      expect(s17.requestStatus).toBe('awaiting_quote');
      expect(s17.messages.at(-1)).toMatchObject({
        authorRole: 'consultant',
        consultantName: 'legal-assistant support',
        body: "Hi Chidi, I've read your brief. Let's look at the lease together.",
      });

      // "Message Adaora": the client replies to the consultant; no AI turn.
      const before = gemini.chats.length;
      const reply = await say(id, {
        body: 'Thank you. I can send the lease.',
      }).expect(201);
      expect(data(reply).messages.at(-1)).toMatchObject({
        authorRole: 'client',
        body: 'Thank you. I can send the lease.',
      });
      expect(gemini.chats.length).toBe(before);
      const opsThread = await http()
        .get(`/api/hub/legal/ops/intakes/chat/${requestId}`)
        .set(bearer(admins.support))
        .expect(200);
      expect(
        data(opsThread).messages.map(
          (m: { authorRole: string; body: string }) => [m.authorRole, m.body],
        ),
      ).toEqual([
        [
          'consultant',
          "Hi Chidi, I've read your brief. Let's look at the lease together.",
        ],
        ['client', 'Thank you. I can send the lease.'],
      ]);
      // A tap is never on offer once the brief is sent.
      const tap = await say(id, { quickReplyId: 'answer:1' }).expect(400);
      expect(refused(tap).reason?.code).toBe('quick_reply_unknown');
    });

    it('before a consultant joins, a sent conversation takes the client message for the consultant without an AI turn', async () => {
      const { id } = await profileToBrief();
      await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(201);
      const before = gemini.chats.length;
      const res = await say(id, {
        body: 'One more thing: the landlord called me.',
      }).expect(201);
      expect(data(res).assistantStopped).toBe(false);
      expect(data(res).messages.at(-1)?.authorRole).toBe('client');
      expect(gemini.chats.length).toBe(before);
    });

    it('after payment, with no consultant yet, the existing paid-wait assistant answers on the same thread', async () => {
      const { id } = await profileToBrief();
      const sent = data(
        await http()
          .post(`/api/hub/legal/assistant/${id}/send`)
          .set(as(token))
          .expect(201),
      );
      await prisma.legalRequest.update({
        where: { id: sent.legalRequestId ?? '' },
        data: { status: 'consultation_scheduled' },
      });
      gemini.queue(
        'Thanks. Your consultant will go through the lease with you.',
      );
      const res = await say(id, { body: 'What should I bring?' }).expect(201);
      expect(
        data(res)
          .messages.slice(-2)
          .map((m: { authorRole: string }) => m.authorRole),
      ).toEqual(['client', 'assistant']);
    });

    it('the transcript route is for superadmin and support only, and never for a user token', async () => {
      const thread = await start();
      await http()
        .get(`/api/hub/legal/ops/intakes/${thread.id}/assistant`)
        .set(as(token))
        .expect(401);
      await http()
        .get(`/api/hub/legal/ops/intakes/${thread.id}/assistant`)
        .set(bearer(admins.finance))
        .expect(403);
      await http()
        .get(`/api/hub/legal/ops/intakes/${thread.id}/assistant`)
        .set(bearer(admins.reviewer))
        .expect(403);
      await http()
        .get(`/api/hub/legal/ops/intakes/${thread.id}/assistant`)
        .set(bearer(admins.superadmin))
        .expect(200);
      await http()
        .get(`/api/hub/legal/ops/intakes/${crypto.randomUUID()}/assistant`)
        .set(bearer(admins.support))
        .expect(404);
    });
  });
});
