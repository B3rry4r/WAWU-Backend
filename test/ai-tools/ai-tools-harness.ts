import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { WawuAuthModule } from '../../src/common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FeeSettings } from '../../src/money/fees/fee-config';
import { PlanSettingsModule } from '../../src/plan-settings/plan-settings.module';
import { PointsModule } from '../../src/points/points.module';
import { PointsService } from '../../src/points/points.service';
import { purgePersonPoints } from '../../src/points/points-purge';
import { PointsJobQuoteToken } from '../../src/points/spend/points-job-quote-token';
import { PointsQuoteService } from '../../src/points/spend/points-quote.service';
import { PointsShortfallService } from '../../src/points/spend/points-shortfall.service';
import { PointsSpendService } from '../../src/points/spend/points-spend.service';
import { AiJobService } from '../../src/ai-tools/ai-job.service';
import { AiToolsController } from '../../src/ai-tools/ai-tools.controller';
import { AiToolsService } from '../../src/ai-tools/ai-tools.service';
import {
  AI_AUDIO_STORE,
  type AiAudioStore,
} from '../../src/ai-tools/audio/ai-audio-store';
import { AI_VOICE_PROVIDER } from '../../src/ai-tools/voice/ai-voice-provider';
import { startStandin, type StandinHandle } from './voice-standin-for-specs';
import { HttpVoiceProvider } from '../../src/ai-tools/voice/http-voice-provider';

/**
 * The shared set-up of the AI tools specs: the real controller, services,
 * points and settings on a real database with real RS256 tokens from
 * mock-wawu-id (like every contract spec), the real HTTP adapter pointed at
 * the voice stand-in (`scripts/dev/voice-standin.cjs`, which stays on this
 * machine), and the audio kept in memory. No payment provider (the Fintava
 * double included) and no real AI provider is started or called.
 */
export const STANDIN_KEY = 'ai01-spec-key';
export const VOICES = JSON.stringify([
  {
    id: 'ada',
    name: 'Ada',
    description: 'Warm, Nigerian English',
    providerVoiceId: 'stand-in-ada',
  },
  {
    id: 'tunde',
    name: 'Tunde',
    description: 'Calm and deep',
    providerVoiceId: 'stand-in-tunde',
  },
]);

/** Seeded WAWU IDs (mock-wawu-id/server.js). */
export const PLAIN = '00000000-0000-4000-8000-000000000001';
export const BASIC = '00000000-0000-4000-8000-000000000002';
export const PRO = '00000000-0000-4000-8000-000000000003';
export const SEEDED = [PLAIN, BASIC, PRO];

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** The audio store of a spec: kept in memory, and it remembers what was put and removed. */
export class MemoryAudioStore implements AiAudioStore {
  readonly files = new Map<string, Buffer>();
  readonly removed: string[] = [];
  failPut = false;
  put(wawuUserId: string, jobId: string, audio: Buffer): Promise<string> {
    if (this.failPut) return Promise.reject(new Error('store down'));
    const key = `ai/voiceover/${wawuUserId}/${jobId}.mp3`;
    this.files.set(key, audio);
    return Promise.resolve(key);
  }
  urlFor(key: string): Promise<string> {
    return Promise.resolve(`https://audio.example.test/${key}`);
  }
  remove(key: string): Promise<void> {
    this.files.delete(key);
    this.removed.push(key);
    return Promise.resolve();
  }
}

type Standin = StandinHandle;

export interface AiHarness {
  app: INestApplication;
  prisma: PrismaService;
  points: PointsService;
  spend: PointsSpendService;
  jobs: AiJobService;
  tokens: PointsJobQuoteToken;
  quotes: PointsQuoteService;
  store: MemoryAudioStore;
  standin: Standin;
  tokensOf: Record<string, string>;
  get<T>(token: unknown): T;
  http(): ReturnType<typeof request>;
  /** A quote token for the cost the job would have (what POST /points/quote hands back). */
  quote(who: string, costPoints: number, ttlSeconds?: number): string;
  /** POST /ai-tools/voiceover/jobs */
  create(
    who: string,
    body: object,
    key?: string | null,
  ): ReturnType<ReturnType<typeof request>['post']>;
  /** Polls the job until it is no longer working. */
  finish(
    who: string,
    id: string,
  ): Promise<{ state: string } & Record<string, unknown>>;
  grant(who: string, n: number): Promise<void>;
  balance(who: string): Promise<number>;
  clean(): Promise<void>;
  close(): Promise<void>;
}

export async function bootAiTools(): Promise<AiHarness> {
  let mock: ChildProcess | undefined;
  if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
    mock = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '../../mock-wawu-id'),
      env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
      stdio: 'ignore',
    });
    if (!(await waitForHealth(`${MOCK_BASE}/health`)))
      throw new Error('mock-wawu-id did not become healthy in time');
  }
  const tokensOf: Record<string, string> = {
    [PLAIN]: await login('user@test.wawu.dev'),
    [BASIC]: await login('creator-basic@test.wawu.dev'),
    [PRO]: await login('creator-pro@test.wawu.dev'),
  };

  // The voice stand-in, on a port the system picks, on 127.0.0.1 only.
  const standin = await startStandin(STANDIN_KEY);
  process.env.AI_VOICE_BASE_URL = `http://127.0.0.1:${standin.port}`;
  process.env.AI_VOICE_API_KEY = STANDIN_KEY;
  process.env.AI_VOICE_VOICES = VOICES;
  process.env.FEE_QUOTE_KEY ??= 'ai01-spec-fee-quote-key-0123456789abcdef';

  const store = new MemoryAudioStore();
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      PlanSettingsModule,
      PointsModule,
    ],
    controllers: [AiToolsController],
    providers: [
      FeeSettings,
      PointsSpendService,
      PointsJobQuoteToken,
      PointsQuoteService,
      // The wallet money for a shortfall is POINTS-03's own check; this spec
      // starts no payment provider, so the quote never offers it.
      {
        provide: PointsShortfallService,
        useValue: {
          offer: () => Promise.resolve({ wallet: null, note: null }),
        },
      },
      AiToolsService,
      AiJobService,
      {
        provide: AI_VOICE_PROVIDER,
        useFactory: (config: ConfigService) => new HttpVoiceProvider(config),
        inject: [ConfigService],
      },
      { provide: AI_AUDIO_STORE, useValue: store },
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

  const prisma = moduleRef.get(PrismaService);
  const points = moduleRef.get(PointsService);
  const tokens = moduleRef.get(PointsJobQuoteToken);
  const http = () => request(app.getHttpServer() as Server);
  const h: AiHarness = {
    app,
    prisma,
    points,
    spend: moduleRef.get(PointsSpendService),
    jobs: moduleRef.get(AiJobService),
    tokens,
    quotes: moduleRef.get(PointsQuoteService),
    store,
    standin,
    tokensOf,
    get: <T>(token: unknown) => moduleRef.get<T>(token as never),
    http,
    quote: (who, costPoints, ttlSeconds = 300) =>
      tokens.issue(
        who,
        'voiceover_per_min',
        costPoints,
        new Date(Date.now() + (ttlSeconds - tokens.seconds) * 1000),
      ),
    create: (who, body, key) => {
      const req = http()
        .post('/ai-tools/voiceover/jobs')
        .set('Authorization', `Bearer ${tokensOf[who]}`);
      if (key !== null) req.set('Idempotency-Key', key ?? randomUUID());
      return req.send(body);
    },
    finish: async (who, id) => {
      for (let i = 0; i < 100; i++) {
        const res = await http()
          .get(`/ai-tools/jobs/${id}`)
          .set('Authorization', `Bearer ${tokensOf[who]}`);
        const job = (
          res.body as { data: { state: string } & Record<string, unknown> }
        ).data;
        if (job.state !== 'working') return job;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the job never finished');
    },
    grant: async (who, n) => {
      await points.grant({
        wawuUserId: who,
        source: 'pack',
        sourceRef: randomUUID(),
        points: n,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      });
    },
    balance: (who) => points.balanceOf(who),
    clean: async () => {
      await prisma.aiToolJob.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      for (const who of SEEDED) await purgePersonPoints(prisma, who);
    },
    close: async () => {
      await app.close();
      await new Promise<void>((r) => standin.server.close(() => r()));
      mock?.kill();
    },
  };
  await h.clean();
  return h;
}
