import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { BlockedAccountModule } from '../../src/blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../src/common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { MakerTierService } from '../../src/plans/maker-tier.service';
import { PlanSettingsModule } from '../../src/plan-settings/plan-settings.module';
import { PointsModule } from '../../src/points/points.module';
import { PointsService } from '../../src/points/points.service';
import { purgePersonPoints } from '../../src/points/points-purge';
import { PointsSpendService } from '../../src/points/spend/points-spend.service';
import { AI_VOICE_PROVIDER } from '../../src/ai-tools/voice/ai-voice-provider';
import { HttpVoiceProvider } from '../../src/ai-tools/voice/http-voice-provider';
import type { VoiceSample } from '../../src/ai-tools/voice/ai-voice-provider';
import {
  VOICE_FILES,
  type VoiceFiles,
} from '../../src/voice-intro/voice-files';
import {
  VoiceIntroController,
  VoiceIntroPublicController,
} from '../../src/voice-intro/voice-intro.controller';
import { VoiceIntroRunService } from '../../src/voice-intro/voice-intro-run.service';
import { VoiceProfileService } from '../../src/voice-intro/voice-profile.service';
import type { VoiceIntroView } from '../../src/voice-intro/voice-intro-view.type';
import {
  startStandin,
  type StandinHandle,
} from '../ai-tools/voice-standin-for-specs';

/**
 * The shared set-up of the Voice Intro specs (VOICE-01): the real controller,
 * services, points, tier reader and settings on a real database with real
 * RS256 tokens from mock-wawu-id, the real HTTP voice adapter pointed at the
 * voice stand-in (`scripts/dev/voice-standin.cjs`, on this machine only), and
 * the files kept in memory. No payment provider (the Fintava double included)
 * and no real AI provider is started or called.
 */
export const STANDIN_KEY = 'voice01-spec-key';
export const VOICES = JSON.stringify([
  {
    id: 'ada',
    name: 'Ada',
    description: 'Warm, Nigerian English',
    providerVoiceId: 'stand-in-ada',
  },
]);

/** Seeded WAWU IDs (mock-wawu-id/server.js). */
export const PLAIN = '00000000-0000-4000-8000-000000000001';
export const BASIC = '00000000-0000-4000-8000-000000000002';
export const PRO = '00000000-0000-4000-8000-000000000003';
export const SEEDED = [PLAIN, BASIC, PRO];

export const FILES_BASE = 'https://voice-files.example.test/';

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

/** The files of a spec, in memory: recordings the spec "uploaded", audio the Hub stored, and what was removed. */
export class MemoryVoiceFiles implements VoiceFiles {
  readonly samples = new Map<string, VoiceSample>();
  readonly audio = new Map<string, Buffer>();
  readonly removed: string[] = [];
  failPut = false;

  keyFromLink(link: string): Promise<string | null> {
    return Promise.resolve(
      link.startsWith(FILES_BASE) && !link.includes('@')
        ? link.slice(FILES_BASE.length)
        : null,
    );
  }
  readSample(key: string): Promise<VoiceSample> {
    const s = this.samples.get(key);
    return s ? Promise.resolve(s) : Promise.reject(new Error('no such file'));
  }
  putAudio(wawuUserId: string, name: string, audio: Buffer): Promise<string> {
    if (this.failPut) return Promise.reject(new Error('store down'));
    const key = `ai/voiceover/${wawuUserId}/${name}.mp3`;
    this.audio.set(key, audio);
    return Promise.resolve(key);
  }
  urlFor(key: string): Promise<string> {
    return Promise.resolve(`${FILES_BASE}${key}`);
  }
  remove(key: string): Promise<void> {
    this.audio.delete(key);
    this.samples.delete(key);
    this.removed.push(key);
    return Promise.resolve();
  }
  reset(): void {
    this.samples.clear();
    this.audio.clear();
    this.removed.length = 0;
    this.failPut = false;
  }
}

export interface VoiceHarness {
  app: INestApplication;
  prisma: PrismaService;
  points: PointsService;
  runs: VoiceIntroRunService;
  files: MemoryVoiceFiles;
  standin: StandinHandle;
  tokensOf: Record<string, string>;
  get<T>(token: unknown): T;
  http(): ReturnType<typeof request>;
  /** `GET`, `PUT` or `POST` on a route as a person. */
  as(
    who: string,
    method: 'get' | 'put' | 'post',
    url: string,
    body?: object,
    headers?: Record<string, string>,
  ): ReturnType<ReturnType<typeof request>['get']>;
  /** A recording the person "uploaded": the stored row and the bytes; returns the link presign would give. */
  upload(
    who: string,
    opts?: { bytes?: Buffer; status?: 'pending' | 'confirmed'; name?: string },
  ): Promise<string>;
  /** Saves words, consent and a sample for a person (the three steps before a try). */
  prepare(who: string, text?: string, bytes?: Buffer): Promise<void>;
  /** A tier row for the person, with or without the included first Voice Intro. */
  giveTier(who: string, included: boolean): Promise<void>;
  /** Polls `GET /me/voice-intro` until the latest try is no longer working. */
  finish(who: string): Promise<VoiceIntroView>;
  grant(who: string, n: number): Promise<void>;
  balance(who: string): Promise<number>;
  clean(): Promise<void>;
  close(): Promise<void>;
}

export async function bootVoice(): Promise<VoiceHarness> {
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

  const files = new MemoryVoiceFiles();
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      PlanSettingsModule,
      PointsModule,
      BlockedAccountModule,
    ],
    controllers: [VoiceIntroController, VoiceIntroPublicController],
    providers: [
      PointsSpendService,
      MakerTierService,
      VoiceProfileService,
      VoiceIntroRunService,
      {
        provide: AI_VOICE_PROVIDER,
        useFactory: (config: ConfigService) => new HttpVoiceProvider(config),
        inject: [ConfigService],
      },
      { provide: VOICE_FILES, useValue: files },
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
  const http = () => request(app.getHttpServer() as Server);
  const h: VoiceHarness = {
    app,
    prisma,
    points,
    runs: moduleRef.get(VoiceIntroRunService),
    files,
    standin,
    tokensOf,
    get: <T>(token: unknown) => moduleRef.get<T>(token as never),
    http,
    as: (who, method, url, body, headers = {}) => {
      const req = http()
        [method](url)
        .set('Authorization', `Bearer ${tokensOf[who]}`);
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      return body ? req.send(body) : req;
    },
    upload: async (who, opts = {}) => {
      const name = opts.name ?? `${randomUUID()}.m4a`;
      const key = `voice/sample/${who}/${name}`;
      const bytes = opts.bytes ?? Buffer.from('a thirty second recording');
      await prisma.storageObject.create({
        data: {
          wawuUserId: who,
          key,
          bytes: bytes.length,
          contentType: 'audio/mp4',
          folder: 'voice/sample',
          status: opts.status ?? 'confirmed',
        },
      });
      files.samples.set(key, { audio: bytes, contentType: 'audio/mp4' });
      return `${FILES_BASE}${key}`;
    },
    prepare: async (who, text = 'I make bright things in Lagos.', bytes) => {
      const view = (await h.as(who, 'get', '/me/voice-intro')).body as {
        data: { consent: { line: string } };
      };
      await h.as(who, 'put', '/me/voice-intro/text', { text }).expect(200);
      await h
        .as(who, 'post', '/me/voice-intro/consent', {
          line: view.data.consent.line,
        })
        .expect(200);
      const link = await h.upload(who, { bytes });
      await h
        .as(who, 'post', '/me/voice-intro/sample', { fileUrl: link })
        .expect(200);
    },
    giveTier: async (who, included) => {
      const data = {
        tierId: 'verify',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 3,
        pointsIncluded: 0,
        voiceIntroIncluded: included,
      };
      await prisma.makerTier.upsert({
        where: { wawuUserId: who },
        create: { wawuUserId: who, ...data },
        update: data,
      });
    },
    finish: async (who) => {
      for (let i = 0; i < 100; i++) {
        const res = await h.as(who, 'get', '/me/voice-intro');
        const view = (res.body as { data: VoiceIntroView }).data;
        if (view.run?.state !== 'working') return view;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the try never finished');
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
      await prisma.voiceIntroRun.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.voiceProfile.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.voiceNamePreview.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.storageObject.deleteMany({
        where: { wawuUserId: { in: SEEDED }, folder: 'voice/sample' },
      });
      await prisma.makerTier.deleteMany({
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
