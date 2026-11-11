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
  startStandin,
  type StandinHandle,
} from '../../../../test/ai-tools/voice-standin-for-specs';
import { LegalIntakeModule } from '../../legal-intake.module';

/**
 * LEGAL-ELEVEN (R-137): the legal assistant on the agent platform, through the real services, routes and database.
 * The AI provider is the voice stand-in (scripts/dev/voice-standin.cjs): nothing reaches a real provider.
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

const ADMIN_ENV = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];
const KEY = 'legal-eleven-contract-key';

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

const TURN = {
  reply: 'Got it. Is the lease written and signed, and how long is left on it?',
  quickReplies: [],
  matter: 'property',
  headline: 'Tenancy · rent increase',
  facts: [{ label: 'Rent rise', value: '60% mid-lease' }],
  answers: { property_role: 'tenant' },
  briefReady: false,
};
const READY = {
  ...TURN,
  reply: "Thanks. Here's what I'll pass on.",
  briefReady: true,
};
const BRIEF = {
  summary: 'A tenant faces a mid-lease rent rise.',
  keyIssues: ['Whether the lease allows a rent review'],
  questionsToClarify: ['What does the review clause say?'],
  risks: [],
};

interface ThreadView {
  id: string;
  stage: string;
  messages: Array<{ authorRole: string; body: string }>;
  awaitingReply: boolean;
  legalRequestId: string | null;
}
const data = <T = ThreadView>(res: { body: unknown }): T =>
  (res.body as { data: T }).data;

describe('LEGAL-ELEVEN: the legal assistant on the agent platform (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let standin: StandinHandle;
  let mockWawuId: ChildProcess | undefined;
  let owned = false;
  let token: string;
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer() as App);
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const say = (id: string, body: object) =>
    http()
      .post(`/api/hub/legal/assistant/${id}/messages`)
      .set(as(token))
      .send(body);

  async function cleanUp() {
    const intakes = await prisma.legalIntake.findMany({
      where: { wawuUserId: ME },
      select: { legalRequestId: true },
    });
    const requestIds = intakes
      .map((i) => i.legalRequestId)
      .filter((v): v is string => Boolean(v));
    await prisma.legalAssistantCall.deleteMany({ where: { wawuUserId: ME } });
    await prisma.legalIntakeMessage.deleteMany({ where: { wawuUserId: ME } });
    await prisma.legalIntake.deleteMany({ where: { wawuUserId: ME } });
    if (requestIds.length > 0) {
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: requestIds } },
      });
    }
    await prisma.legalRequest.deleteMany({ where: { wawuUserId: ME } });
  }

  beforeAll(async () => {
    for (const key of [...ADMIN_ENV, 'AI_VOICE_BASE_URL', 'AI_VOICE_API_KEY']) {
      envSnapshot[key] = process.env[key];
    }
    standin = await startStandin(KEY);
    process.env.AI_VOICE_BASE_URL = `http://127.0.0.1:${standin.port}`;
    process.env.AI_VOICE_API_KEY = KEY;
    process.env.ADMIN_JWT_SECRET =
      'legal-eleven-access-secret-0123456789abcdef';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'legal-eleven-refresh-secret-0123456789abcdef';

    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      owned = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }

    // No provider is overridden: the module's own client, the real voice adapter and the stand-in behind it.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        LegalIntakeModule,
      ],
    }).compile();
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
    token = await login(ME_EMAIL);
  }, 40000);

  afterEach(async () => {
    await cleanUp();
    standin.state.chats.length = 0;
    standin.state.nextAgentReplies.length = 0;
  });

  afterAll(async () => {
    if (prisma) await cleanUp();
    await app?.close();
    await new Promise<void>((r) => standin.server.close(() => r()));
    if (owned && mockWawuId) mockWawuId.kill();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 30000);

  const start = async () =>
    data(
      await http().post('/api/hub/legal/assistant').set(as(token)).expect(201),
    );

  it('profiles a matter and sends the brief, every AI turn a text-only agent conversation that carries nothing about the person', async () => {
    const thread = await start();
    standin.state.nextAgentReplies.push(
      JSON.stringify(TURN),
      JSON.stringify(READY),
      JSON.stringify(BRIEF),
    );
    const first = data(
      await say(thread.id, { quickReplyId: 'topic:property' }).expect(201),
    );
    expect(first.messages.some((m) => m.body === TURN.reply)).toBe(true);
    const second = data(
      await say(thread.id, {
        body: 'My landlord wants to raise my rent by 60% mid-lease.',
      }).expect(201),
    );
    expect(second.messages.some((m) => m.body === READY.reply)).toBe(true);

    const sent = data(
      await http()
        .post(`/api/hub/legal/assistant/${thread.id}/send`)
        .set(as(token))
        .expect(201),
    );
    expect(sent.stage).toBe('sent');

    const chats = standin.state.chats;
    expect(chats).toHaveLength(3);
    for (const chat of chats) {
      expect(chat.textOnly).toBe(true);
      expect(chat.override?.allowed).toBe(true);
      expect(chat.override?.llm).toBe('gemini-3-flash-preview');
      expect(chat.keyLeak).toBe(false);
      const sentOut = `${chat.override?.prompt}\n${chat.message}`;
      for (const secret of [
        ME_FIRST_NAME,
        ME_LAST_NAME,
        ME_EMAIL,
        ME_PHONE_TAIL,
        ME,
        thread.id,
      ]) {
        expect(sentOut).not.toContain(secret);
      }
      expect(sentOut).not.toMatch(/[\u2013\u2014]/);
    }
    const intake = await prisma.legalIntake.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect((intake.brief as { generatedBy: string }).generatedBy).toBe(
      'elevenlabs:gemini-3-flash-preview',
    );
    expect(
      (intake.brief as { analysis: { summary: string } }).analysis.summary,
    ).toBe(BRIEF.summary);
  });

  it('fails a reply that is not the expected JSON with the same message and holds nothing', async () => {
    const thread = await start();
    standin.state.nextAgentReplies.push(
      'Sure, here is some prose instead of JSON.',
    );
    const res = await say(thread.id, { quickReplyId: 'topic:property' }).expect(
      503,
    );
    const body = res.body as { message: string; reason: { code: string } };
    expect(body.reason.code).toBe('assistant_unavailable');
    expect(body.message).toBe(
      'Your message was saved. The assistant could not reply just now. Try again in a moment.',
    );
    const rows = await prisma.legalIntakeMessage.findMany({
      where: { legalIntakeId: thread.id },
    });
    expect(
      rows.filter((r) => r.authorRole === 'assistant' && /prose/.test(r.body)),
    ).toHaveLength(0);
    const intake = await prisma.legalIntake.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(intake.draftBrief).toBeNull();
  });
});
