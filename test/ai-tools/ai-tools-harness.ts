import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AccountPurgeService } from '../../src/account-purge/account-purge.service';
import { AccountPurgeHooks } from '../../src/account-purge/purge-hooks';
import { AiToolsPurgeService } from '../../src/ai-tools/ai-tools-purge.service';
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
import { AiToolsPieceController } from '../../src/ai-tools/ai-tools-piece.controller';
import { AiFlowService } from '../../src/ai-tools/flow/ai-flow.service';
import { AiAudiobookService } from '../../src/ai-tools/audiobook/ai-audiobook.service';
import { AiPodcastService } from '../../src/ai-tools/podcast/ai-podcast.service';
import { ReceptionistController } from '../../src/ai-tools/receptionist/receptionist.controller';
import { ReceptionistService } from '../../src/ai-tools/receptionist/receptionist.service';
import {
  AI_MEDIA_STORE,
  type AiMediaStore,
  type AiMediaFolder,
  pieceFormatFor,
} from '../../src/ai-tools/media/ai-media-store';
import { NotificationService } from '../../src/notification/notification.service';
import { PlansService } from '../../src/plans/plans.service';
import { PublishingAllowanceService } from '../../src/plans/publishing-allowance.service';
import { EXTENSION_FOR_CONTENT_TYPE } from '../../src/storage/dto/presign-upload.dto';
import { createHash } from 'node:crypto';
import { AiVoiceSamplesController } from '../../src/ai-tools/ai-voice-samples.controller';
import { AiToolsService } from '../../src/ai-tools/ai-tools.service';
import {
  AI_AUDIO_STORE,
  type AiAudioStore,
} from '../../src/ai-tools/audio/ai-audio-store';
import {
  AI_INPUT_FILES,
  AiInputService,
  type AiInputFiles,
  type InputFileRow,
} from '../../src/ai-tools/input/ai-input-files';
import { AI_VOICE_PROVIDER } from '../../src/ai-tools/voice/ai-voice-provider';
import { startStandin, type StandinHandle } from './voice-standin-for-specs';
import { AppController } from '../../src/app.controller';
import { HttpVoiceProvider } from '../../src/ai-tools/voice/http-voice-provider';
import { ProviderCopyService } from '../../src/ai-tools/voice/provider-copy.service';
import { OwnVoiceService } from '../../src/ai-tools/own-voice/own-voice.service';
import { AiCloneService } from '../../src/ai-tools/own-voice/ai-clone.service';
import {
  VOICE_FILES,
  type VoiceFiles,
} from '../../src/voice-intro/voice-files';
import type { VoiceSample } from '../../src/ai-tools/voice/ai-voice-provider';

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
  put(
    wawuUserId: string,
    jobId: string,
    audio: Buffer,
    contentType?: string,
    folder: string = 'ai/voiceover',
  ): Promise<string> {
    if (this.failPut) return Promise.reject(new Error('store down'));
    const ext =
      contentType === 'audio/wav'
        ? 'wav'
        : contentType === 'audio/mp4'
          ? 'm4a'
          : contentType === 'audio/aac'
            ? 'aac'
            : contentType === 'audio/flac'
              ? 'flac'
              : 'mp3';
    const key = `${folder}/${wawuUserId}/${jobId}.${ext}`;
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
  list(
    wawuUserId: string,
    folder: string,
    namePrefix: string,
  ): Promise<string[]> {
    const start = `${folder}/${wawuUserId}/${namePrefix}`;
    return Promise.resolve(
      [...this.files.keys()].filter((k) => k.startsWith(start)).sort(),
    );
  }
}

/**
 * The pictures and videos of a spec (AITOOLS-08 to -10), kept in memory. A
 * result is read as a stream and only its length and first bytes are kept, so a
 * spec can store 60 MB with the Hub's memory flat. It reads the audio store's
 * files too (a Talking photo reads a finished voice result), and copies a
 * result into content the way `StorageService.copyIntoContent` does: a key made
 * from the seed, the same key again until it is released.
 */
export class MemoryMediaStore implements AiMediaStore {
  readonly files = new Map<
    string,
    { bytes: number; contentType: string; head: Buffer; wawuUserId: string }
  >();
  readonly removed: string[] = [];
  /** Content copies by key: who owns it, which result it was made from, and whether it was released. */
  readonly copies = new Map<
    string,
    {
      wawuUserId: string;
      source: string;
      released: boolean;
      contentType: string;
      bytes: number;
    }
  >();
  failPut = false;
  /** A refusal for the next copies (the presign's tier or storage answer). */
  copyRefusal: Error | null = null;
  /** The audio store whose files a read may also find. */
  audio: MemoryAudioStore | null = null;
  /** Peak of the bytes held by a `put` at any moment (a stream is counted chunk by chunk). */
  async put(
    wawuUserId: string,
    jobId: string,
    stream: Readable,
    contentType: string,
    folder: AiMediaFolder,
    maxBytes: number,
  ): Promise<{ key: string; bytes: number }> {
    if (this.failPut) {
      stream.destroy();
      throw new Error('store down');
    }
    let bytes = 0;
    let head = Buffer.alloc(0);
    for await (const chunk of stream) {
      const c = chunk as Buffer;
      bytes += c.length;
      if (bytes > maxBytes) throw new Error('too big');
      if (head.length < 64) head = Buffer.concat([head, c]).subarray(0, 64);
    }
    if (bytes === 0) throw new Error('empty');
    const ext = EXTENSION_FOR_CONTENT_TYPE[contentType] ?? 'bin';
    const key = `${folder}/${wawuUserId}/${jobId}.${ext}`;
    this.files.set(key, { bytes, contentType, head, wawuUserId });
    return { key, bytes };
  }
  urlFor(key: string): Promise<string> {
    return Promise.resolve(`https://media.example.test/${key}`);
  }
  downloadUrlFor(key: string, fileName: string): Promise<string> {
    return Promise.resolve(
      `https://media.example.test/${key}?download=${fileName}`,
    );
  }
  remove(key: string): Promise<void> {
    this.files.delete(key);
    this.removed.push(key);
    return Promise.resolve();
  }
  read(key: string): Promise<{ audio: Buffer; contentType: string }> {
    const f = this.audio?.files.get(key);
    if (!f) return Promise.reject(new Error('no such file'));
    return Promise.resolve({
      audio: Buffer.from(new Uint8Array(f)),
      contentType: key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
    });
  }
  open(
    key: string,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }> {
    const f = this.audio?.files.get(key);
    if (!f) return Promise.reject(new Error('no such file'));
    return Promise.resolve({
      stream: Readable.from([f], { objectMode: false }),
      bytes: f.length,
      contentType: key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
    });
  }
  copyIntoContent(wawuUserId: string, sourceKey: string, seed: string) {
    if (this.copyRefusal) return Promise.reject(this.copyRefusal);
    const f = this.files.get(sourceKey);
    const a = this.audio?.files.get(sourceKey);
    if (!f && !a) return Promise.reject(new Error('no such result'));
    const contentType =
      f?.contentType ??
      (sourceKey.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
    const bytes = f?.bytes ?? a!.length;
    for (let n = 0; n < 10; n++) {
      const h = createHash('sha256')
        .update(`${wawuUserId}\n${seed}\n${n}`)
        .digest('hex');
      const key = `content/full/${wawuUserId}/${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}.${EXTENSION_FOR_CONTENT_TYPE[contentType] ?? 'bin'}`;
      const existing = this.copies.get(key);
      if (existing && !existing.released)
        return Promise.resolve({
          key,
          fileUrl: `https://media.example.test/${key}`,
          bytes,
          contentType,
          replayed: true,
        });
      if (existing) continue;
      this.copies.set(key, {
        wawuUserId,
        source: sourceKey,
        released: false,
        contentType,
        bytes,
      });
      return Promise.resolve({
        key,
        fileUrl: `https://media.example.test/${key}`,
        bytes,
        contentType,
        replayed: false,
      });
    }
    return Promise.reject(new Error('too many copies'));
  }
}
export { pieceFormatFor };

/**
 * The person's uploaded files of a spec (AITOOLS-04), kept in memory: it
 * answers `find` as the storage rows do (own file, input folder, landed) and
 * remembers what was removed.
 */
export class MemoryInputFiles implements AiInputFiles {
  readonly files = new Map<
    string,
    {
      wawuUserId: string;
      folder: string;
      data: Buffer;
      contentType: string;
      landed: boolean;
    }
  >();
  readonly removed: string[] = [];
  failRead = false;
  add(
    wawuUserId: string,
    data: Buffer,
    contentType: string,
    folder = 'ai/input-audio',
    landed = true,
  ): string {
    const ext = contentType.split('/')[1] ?? 'bin';
    const key = `${folder}/${wawuUserId}/${randomUUID()}.${ext}`;
    this.files.set(key, { wawuUserId, folder, data, contentType, landed });
    return key;
  }
  find(wawuUserId: string, key: string): Promise<InputFileRow | null> {
    const f = this.files.get(key);
    if (!f || f.wawuUserId !== wawuUserId || !f.landed)
      return Promise.resolve(null);
    return Promise.resolve({
      key,
      folder: f.folder,
      bytes: f.data.length,
      contentType: f.contentType,
    });
  }
  /** Every read of a file's bytes, whole or its head, in order (the specs count them). */
  readonly reads: { key: string; kind: 'head' | 'whole' }[] = [];
  readHead(key: string, bytes: number): Promise<Buffer> {
    const f = this.files.get(key);
    this.reads.push({ key, kind: 'head' });
    if (this.failRead || !f) return Promise.reject(new Error('file gone'));
    return Promise.resolve(Buffer.from(f.data.subarray(0, bytes)));
  }
  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }> {
    const f = this.files.get(key);
    this.reads.push({ key, kind: 'whole' });
    if (this.failRead || !f || f.data.length > maxBytes)
      return Promise.reject(new Error('file gone'));
    // A fresh copy each time, as the storage read gives (the length reader
    // may take the bytes' memory over).
    return Promise.resolve({
      audio: Buffer.from(new Uint8Array(f.data)),
      contentType: f.contentType,
    });
  }
  length(key: string): Promise<number> {
    const f = this.files.get(key);
    if (this.failRead || !f) return Promise.reject(new Error('file gone'));
    return Promise.resolve(f.data.length);
  }
  /** Every provider-run open, in order (the specs count them). */
  readonly opens: string[] = [];
  open(
    key: string,
    maxBytes: number,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }> {
    const f = this.files.get(key);
    this.opens.push(key);
    if (this.failRead || !f || f.data.length > maxBytes)
      return Promise.reject(new Error('file gone'));
    const data = f.data;
    // 64 KB pieces, as a store's body arrives; nothing is copied.
    return Promise.resolve({
      stream: Readable.from(
        (function* () {
          for (let at = 0; at < data.length; at += 65536)
            yield data.subarray(at, Math.min(data.length, at + 65536));
        })(),
        { objectMode: false },
      ),
      bytes: data.length,
      contentType: f.contentType,
    });
  }
  remove(key: string): Promise<void> {
    this.files.delete(key);
    this.removed.push(key);
    return Promise.resolve();
  }
  /** Words kept for a job as a private file (AITOOLS-13). */
  putText(wawuUserId: string, name: string, text: string): Promise<string> {
    return Promise.resolve(this.addNamed(wawuUserId, name, text));
  }
  private addNamed(wawuUserId: string, name: string, text: string): string {
    const key = `ai/input-doc/${wawuUserId}/${name}.txt`;
    this.files.set(key, {
      wawuUserId,
      folder: 'ai/input-doc',
      data: Buffer.from(text, 'utf8'),
      contentType: 'text/plain',
      landed: true,
    });
    return key;
  }
}

type Standin = StandinHandle;

/** The person's Voice Intro recordings, kept in memory (AITOOLS-07: "Your voice" is made from one). */
export class MemoryVoiceFiles implements VoiceFiles {
  readonly samples = new Map<string, VoiceSample>();
  keyFromLink(): Promise<string | null> {
    return Promise.resolve(null);
  }
  readSample(key: string): Promise<VoiceSample> {
    const s = this.samples.get(key);
    return s ? Promise.resolve(s) : Promise.reject(new Error('no such file'));
  }
  putAudio(): Promise<string> {
    return Promise.resolve('memory');
  }
  urlFor(key: string): Promise<string> {
    return Promise.resolve(`https://files.test/${key}`);
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

export interface AiHarness {
  app: INestApplication;
  prisma: PrismaService;
  points: PointsService;
  spend: PointsSpendService;
  jobs: AiJobService;
  tokens: PointsJobQuoteToken;
  quotes: PointsQuoteService;
  store: MemoryAudioStore;
  /** AITOOLS-08 to -10: set when the harness is booted with `media: true`. */
  media: MemoryMediaStore;
  flows: AiFlowService;
  /** AITOOLS-11: the saved clone service. */
  clones: AiCloneService;
  /** AITOOLS-13, AITOOLS-06: set when the harness is booted with `studio3: true`. */
  audiobooks: AiAudiobookService;
  podcasts: AiPodcastService;
  receptionist: ReceptionistService;
  inputs: MemoryInputFiles;
  voiceFiles: MemoryVoiceFiles;
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

export interface BootOptions {
  /** Boots the Studio picture and video tools too (AITOOLS-08 to -10): the media store, the follower, notifications and the piece route. */
  media?: boolean;
  /** A voice list (the JSON `AI_VOICE_VOICES` holds) instead of the two the specs use: a scene of more than 10 voices needs more. */
  voices?: string;
  /** Boots the Audiobook, the Podcast maker and the Receptionist too (AITOOLS-13, AITOOLS-06). Needs `media: true`. */
  studio3?: boolean;
}

export async function bootAiTools(boot: BootOptions = {}): Promise<AiHarness> {
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
  process.env.AI_VOICE_VOICES = boot.voices ?? VOICES;
  process.env.FEE_QUOTE_KEY ??= 'ai01-spec-fee-quote-key-0123456789abcdef';

  const store = new MemoryAudioStore();
  const mediaStore = new MemoryMediaStore();
  mediaStore.audio = store;
  const inputs = new MemoryInputFiles();
  const voiceFiles = new MemoryVoiceFiles();
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      PlanSettingsModule,
      PointsModule,
    ],
    // AppController: GET /health, so a spec can show the Hub answers while a hostile file is being read.
    controllers: [
      AiToolsController,
      AiVoiceSamplesController,
      AppController,
      ...(boot.media ? [AiToolsPieceController] : []),
      ...(boot.studio3 ? [ReceptionistController] : []),
    ],
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
      { provide: AI_INPUT_FILES, useValue: inputs },
      AiInputService,
      ProviderCopyService,
      OwnVoiceService,
      // AITOOLS-11: the saved clone of a person's own voice.
      AiCloneService,
      { provide: VOICE_FILES, useValue: voiceFiles },
      // AITOOLS-07 round 3: the account purge, with the AI tools' step that
      // removes a voice copy at the provider before the job rows go.
      AccountPurgeHooks,
      AccountPurgeService,
      AiToolsPurgeService,
      ...(boot.media
        ? [
            { provide: AI_MEDIA_STORE, useValue: mediaStore },
            AiFlowService,
            NotificationService,
            // The gate's offers are only read when a tier answer is thrown; a spec that needs them uses the real module.
            { provide: PlansService, useValue: {} },
            { provide: PublishingAllowanceService, useValue: {} },
          ]
        : []),
      ...(boot.studio3
        ? [AiAudiobookService, AiPodcastService, ReceptionistService]
        : []),
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
    media: mediaStore,
    flows: boot.media ? moduleRef.get(AiFlowService) : (undefined as never),
    clones: moduleRef.get(AiCloneService),
    audiobooks: boot.studio3
      ? moduleRef.get(AiAudiobookService)
      : (undefined as never),
    podcasts: boot.studio3
      ? moduleRef.get(AiPodcastService)
      : (undefined as never),
    receptionist: boot.studio3
      ? moduleRef.get(ReceptionistService)
      : (undefined as never),
    inputs,
    voiceFiles,
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
        // The Studio tools are followed, not awaited: one pass of the follower each time round.
        if (boot.media) await moduleRef.get(AiFlowService).pass();
        // AITOOLS-13: an audiobook and a podcast are followed too.
        if (boot.studio3) {
          await moduleRef.get(AiAudiobookService).pass();
          await moduleRef.get(AiPodcastService).pass();
        }
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
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: SEEDED }, kind: 'ai_job_ready' },
      });
      await prisma.aiClonedVoice.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.receptionistTurn.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.receptionistKnowledge.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.receptionistAgent.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.aiToolJob.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.voiceProfile.deleteMany({
        where: { wawuUserId: { in: SEEDED } },
      });
      await prisma.productDraft.deleteMany({
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
