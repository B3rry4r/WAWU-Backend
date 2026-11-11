// LEGAL-ELEVEN: which provider writes the brief on POST /legal/intake/:id/complete (a route the web calls). Real HTTP,
// real database, stand-ins only (a Gemini stand-in in place of the Gemini adapter, the voice stand-in for the agent
// platform). Always via `npm run test:contract`.
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
import { RealGeminiAdapter } from '../../common/ai/real-gemini.adapter';
import {
  startStandin,
  type StandinHandle,
} from '../../../test/ai-tools/voice-standin-for-specs';
import { LegalIntakeModule } from '../legal-intake.module';

const USER = '00000000-0000-4000-8000-000000000001';
const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const KEY = 'legal-eleven-pick-key';

const ANSWERS = {
  client_type: 'business_owner',
  based_in: 'nigeria',
  jurisdiction: 'nigeria',
  description:
    'A customer took delivery of goods in March and has not paid the invoice. They stopped replying in June.',
  stage: 'dispute',
  urgency: 'urgent',
  outcome: ['recover_money'],
  engagement: 'advice_first',
  has_documents: 'yes',
  other_party: 'yes',
  involves_money: 'yes',
  amount_band: '1m_5m',
  debt_written_agreement: 'yes',
  debt_age: '3_12m',
};

async function healthy(url: string, ms = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe('LEGAL-ELEVEN: the provider that writes the intake brief (contract)', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let owned = false;
  let standin: StandinHandle;
  let token: string;
  const gemini = { briefs: 0 };
  const saved: Record<string, string | undefined> = {};

  async function boot(withKeys: boolean) {
    if (withKeys) {
      process.env.AI_VOICE_BASE_URL = `http://127.0.0.1:${standin.port}`;
      process.env.AI_VOICE_API_KEY = KEY;
    } else {
      delete process.env.AI_VOICE_BASE_URL;
      delete process.env.AI_VOICE_API_KEY;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        LegalIntakeModule,
      ],
    })
      .overrideProvider(RealGeminiAdapter)
      .useValue({
        generateBrief: () => {
          gemini.briefs += 1;
          return Promise.resolve({
            summary: 'From the Gemini stand-in.',
            keyIssues: ['Issue'],
            questionsToClarify: ['Question?'],
            risks: [],
          });
        },
        chat: () => Promise.reject(new Error('not used')),
      })
      .compile();
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
  }

  const complete = async () => {
    const server = app!.getHttpServer();
    const made = await request(server)
      .post('/legal/intake')
      .set('Authorization', `Bearer ${token}`)
      .send({ matter: 'debt_recovery' })
      .expect(201);
    const id = made.body.data.id as string;
    await request(server)
      .patch(`/legal/intake/${id}/answers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: ANSWERS })
      .expect(200);
    return request(server)
      .post(`/legal/intake/${id}/complete`)
      .set('Authorization', `Bearer ${token}`);
  };

  beforeAll(async () => {
    for (const k of ['AI_VOICE_BASE_URL', 'AI_VOICE_API_KEY'])
      saved[k] = process.env[k];
    standin = await startStandin(KEY);
    if (!(await healthy(`${MOCK_BASE}/health`, 1500))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      owned = true;
      await healthy(`${MOCK_BASE}/health`);
    }
    const res = await fetch(`${MOCK_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  }, 40000);

  afterEach(async () => {
    if (prisma)
      await prisma.legalIntake.deleteMany({ where: { wawuUserId: USER } });
    await app?.close();
    app = undefined;
    gemini.briefs = 0;
    standin.state.chats.length = 0;
    standin.state.nextAgentReplies.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
    if (owned && mock) mock.kill();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 30000);

  it("keeps today's Gemini path and its 201 brief on a server without the agent platform keys", async () => {
    await boot(false);
    const res = await complete();
    expect(res.status).toBe(201);
    expect(res.body.data.brief.analysis.summary).toBe(
      'From the Gemini stand-in.',
    );
    expect(res.body.data.brief.generatedBy).toContain('gemini');
    expect(gemini.briefs).toBe(1);
    expect(standin.state.chats).toHaveLength(0);
  }, 40000);

  it('goes to the agent platform once its keys are set', async () => {
    await boot(true);
    standin.state.nextAgentReplies.push(
      JSON.stringify({
        summary: 'From the agent.',
        keyIssues: ['Issue'],
        questionsToClarify: ['Question?'],
      }),
    );
    const res = await complete();
    expect(res.status).toBe(201);
    expect(res.body.data.brief.analysis.summary).toBe('From the agent.');
    expect(res.body.data.brief.generatedBy).toMatch(/^elevenlabs:/);
    expect(gemini.briefs).toBe(0);
    expect(standin.state.chats).toHaveLength(1);
    expect(standin.state.chats[0].textOnly).toBe(true);
  }, 40000);
});
