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
  deleteAdminFixtures,
  seedAdminFixtures,
} from '../../../common/tests/admin-session.helper';
import { LegalIntakeModule } from '../../legal-intake.module';

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
const OTHER = '00000000-0000-4000-8000-000000000003';

const ADMINS = adminFixtures('1e9a2200', 'legal-r2l2');
const SECRETS = adminJwtSecrets('legal-r2l2');

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
    note: string | null;
  };
  awaitingReply: boolean;
  legalRequestId: string | null;
  requestStatus: string | null;
  requestPath: string | null;
  fixedPrice: null | {
    code: string;
    name: string;
    blurb: string;
    priceNaira: number;
    turnaround: string | null;
    needs: string[];
  };
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

describe('Legal assistant: R2-LEGAL2 fixes (CHECK-3 M-1 to M-4, H-2, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let owned = false;
  let token: string;
  let otherToken: string;
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

  async function setPrice(code: string, naira: number) {
    await prisma.legalServicePrice.upsert({
      where: { serviceCode: code },
      create: { serviceCode: code, priceKobo: naira * 100 },
      update: { priceKobo: naira * 100 },
    });
  }
  afterEach(async () => {
    await prisma.legalServicePrice.deleteMany({
      where: { serviceCode: 'cac-registration' },
    });
  });

  const REGISTRATION = {
    reply: 'Is this for a business name or a company?',
    quickReplies: ['individual', 'business_owner', 'one_only', 'no_rush'],
    matter: 'business_registration',
    headline: 'Business name registration',
    facts: [{ label: 'Wants', value: 'A business name' }],
    answers: {},
    briefReady: false,
  };

  describe('quick replies are words (M-1)', () => {
    it('turns option ids into labels, and a tap sends the label', async () => {
      const thread = await start();
      gemini.queue(REGISTRATION);
      const asked = data(
        await say(thread.id, { body: 'I want to register my business' }).expect(
          201,
        ),
      );
      expect(asked.quickReplies.map((q) => q.label)).toEqual([
        'Individual',
        'Business owner',
        'One only',
        'No rush',
      ]);
      gemini.queue(QUESTION);
      const tapped = data(
        await say(thread.id, { quickReplyId: asked.quickReplies[1].id }).expect(
          201,
        ),
      );
      const mine = tapped.messages.filter((m) => m.authorRole === 'client');
      expect(mine[mine.length - 1].body).toBe('Business owner');
    });
  });

  describe('control characters never reach a person (M-2)', () => {
    it('strips U+0008 from the reply, the headline and the facts, stored and read', async () => {
      const thread = await start();
      gemini.queue({
        ...QUESTION,
        reply: 'Got\u0008 it. How long is left?',
        headline: 'Property\u0008 Rent increase dispute',
        facts: [{ label: 'Rent\u0007 rise', value: '60%\u001F mid-lease' }],
      });
      const next = data(
        await say(thread.id, { body: 'My rent is going up' }).expect(201),
      );
      const last = next.messages[next.messages.length - 1].body;
      expect(last).toBe('Got it. How long is left?');
      const stored = await prisma.legalIntake.findUniqueOrThrow({
        where: { id: thread.id },
      });
      // JSON writes a control character as \\b or \\u00xx: neither may be there.
      expect(JSON.stringify(stored.draftBrief)).not.toMatch(/\\(b|u00[01])/);
    });

    it('cleans a control character already stored in the brief', async () => {
      const { id } = await profileToBrief();
      await prisma.legalIntake.update({
        where: { id },
        data: {
          draftBrief: {
            headline: 'Property\u0008 Rent increase dispute',
            facts: [{ label: 'Lease', value: 'Signed\u0007, 14 months' }],
            ready: true,
          },
        },
      });
      const res = await http()
        .get(`/api/hub/legal/assistant/${id}`)
        .set(as(token))
        .expect(200);
      expect(data(res).brief?.rows).toEqual([
        { label: 'Matter', value: 'Property Rent increase dispute' },
        { label: 'Lease', value: 'Signed , 14 months' },
      ]);
    });
  });

  describe('the line under Send (M-3, G-500)', () => {
    it('is served while the brief can be sent, and not after', async () => {
      const { id, s16 } = await profileToBrief();
      expect(s16.brief?.note).toBe('Nothing is charged yet.');
      const sent = data(
        await http()
          .post(`/api/hub/legal/assistant/${id}/send`)
          .set(as(token))
          .expect(201),
      );
      expect(sent.brief?.note).toBeNull();
      const request = await prisma.legalRequest.findUniqueOrThrow({
        where: { id: sent.legalRequestId as string },
      });
      // The sentence is true: sending opens a matter with nothing owed.
      expect(request).toMatchObject({
        status: 'awaiting_quote',
        quoteAmount: null,
        consultationFee: null,
        servicePaidAt: null,
      });
    });
  });

  describe('the provider is out of calls for the day (M-4)', () => {
    it('says the assistant is busy, keeps the message, and Ask again can follow', async () => {
      const thread = await start();
      gemini.queue(new Error('Gemini chat returned HTTP 429'));
      const res = await say(thread.id, { body: 'My rent is going up' }).expect(
        503,
      );
      expect(refused(res).reason?.code).toBe('assistant_at_capacity');
      expect(refused(res).message).toBe(
        'The assistant is busy right now. Your message is saved.',
      );
      const kept = data(
        await http()
          .get(`/api/hub/legal/assistant/${thread.id}`)
          .set(as(token))
          .expect(200),
      );
      expect(kept.awaitingReply).toBe(true);
      gemini.queue(new Error('Gemini chat returned HTTP 429'));
      const again = await http()
        .post(`/api/hub/legal/assistant/${thread.id}/reply`)
        .set(as(token))
        .expect(503);
      expect(refused(again).reason?.code).toBe('assistant_at_capacity');
      gemini.queue(QUESTION);
      await http()
        .post(`/api/hub/legal/assistant/${thread.id}/reply`)
        .set(as(token))
        .expect(201);
    });

    it('keeps the old words for any other provider failure', async () => {
      const thread = await start();
      gemini.queue(new Error('Gemini chat returned HTTP 503'));
      const res = await say(thread.id, { body: 'My rent is going up' }).expect(
        503,
      );
      expect(refused(res).reason?.code).toBe('assistant_unavailable');
    });
  });

  describe('a fixed-price matter starts from the chat (H-2, S24 to S26)', () => {
    const toRegistration = async () => {
      const thread = await start();
      gemini.queue(
        { ...REGISTRATION, quickReplies: [] },
        { ...REGISTRATION, quickReplies: [] },
      );
      await say(thread.id, {
        quickReplyId: 'topic:business_registration',
      }).expect(201);
      const res = await say(thread.id, {
        body: 'I want to register my business name.',
      }).expect(201);
      return { id: thread.id, thread: data(res) };
    };

    it('carries the price WAWU set, and nothing when WAWU set none', async () => {
      const none = await toRegistration();
      expect(none.thread.fixedPrice).toBeNull();
      await setPrice('cac-registration', 35000);
      const res = await http()
        .get(`/api/hub/legal/assistant/${none.id}`)
        .set(as(token))
        .expect(200);
      expect(data(res).fixedPrice).toEqual({
        code: 'cac-registration',
        name: 'CAC business name registration',
        blurb:
          'Register your business name with the Corporate Affairs Commission.',
        priceNaira: 35000,
        turnaround: '5 to 7 working days',
        needs: ['ID', '2 name options', 'address'],
      });
    });

    it('refuses to send such a matter to a consultant, and starts the request at the admin price', async () => {
      await setPrice('cac-registration', 35000);
      const { id } = await toRegistration();
      const sendRes = await http()
        .post(`/api/hub/legal/assistant/${id}/send`)
        .set(as(token))
        .expect(409);
      expect(refused(sendRes).reason?.code).toBe('fixed_price_matter');

      const started = data(
        await http()
          .post(`/api/hub/legal/assistant/${id}/start`)
          .set(as(token))
          .send({ firstNameChoice: 'Lennox Films' })
          .expect(201),
      );
      expect(started).toMatchObject({
        stage: 'sent',
        requestStatus: 'quoted',
        requestPath: 'simple',
        fixedPrice: null,
      });
      const request = await prisma.legalRequest.findUniqueOrThrow({
        where: { id: started.legalRequestId as string },
      });
      expect(request).toMatchObject({
        serviceCode: 'cac-registration',
        path: 'simple',
        status: 'quoted',
        quoteAmount: 35000,
        documents: [],
        consultationFee: null,
      });
      const last = started.messages[started.messages.length - 1];
      expect(last.authorRole).toBe('assistant');
      expect(last.body).toBe(
        'Your request is open. Sign the agreement and pay to start. To file it we need: ID, 2 name options, address. Write them here and your consultant will pick them up.',
      );

      // Once is once: a second start opens nothing new.
      const again = data(
        await http()
          .post(`/api/hub/legal/assistant/${id}/start`)
          .set(as(token))
          .send({ firstNameChoice: 'Another Name' })
          .expect(201),
      );
      expect(again.legalRequestId).toBe(started.legalRequestId);
      expect(
        await prisma.legalRequest.count({ where: { wawuUserId: ME } }),
      ).toBe(1);

      // The letter is signed on the matter and the fee follows: nothing else is needed.
      const letter = await http()
        .get(`/api/hub/legal/requests/${started.legalRequestId}`)
        .set(as(token));
      expect(letter.status).toBeLessThan(500);
    });

    it('refuses a matter that needs a consultant, and another person gets 404', async () => {
      await setPrice('cac-registration', 35000);
      const thread = await start();
      const res = await http()
        .post(`/api/hub/legal/assistant/${thread.id}/start`)
        .set(as(token))
        .send({ firstNameChoice: 'Lennox Films' })
        .expect(409);
      expect(refused(res).reason?.code).toBe('not_fixed_price');
      const { id } = await toRegistration();
      await http()
        .post(`/api/hub/legal/assistant/${id}/start`)
        .set(as(otherToken))
        .send({ firstNameChoice: 'Lennox Films' })
        .expect(404);
      await http()
        .post(`/api/hub/legal/assistant/${id}/start`)
        .set(as(token))
        .send({ firstNameChoice: 'x' })
        .expect(400);
    });
  });
});
