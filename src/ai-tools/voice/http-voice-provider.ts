import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { ConfigService } from '@nestjs/config';
import { AI_AUDIO_CONTENT_TYPES } from '../audio/ai-audio-store';
import { ZIP_LIMITS } from '../music/zip-reader';
import { looksLikeMp3 } from '../music/stem-names';
import {
  AiVoiceProviderError,
  clipLengthFits,
  type AiVoice,
  type ChangeVoiceRequest,
  type ClonedVoice,
  type CloneVoiceRequest,
  type DialogueRequest,
  type MusicForVideoRequest,
  type SplitStemsRequest,
  type StemArchive,
  type AgentSpec,
  type AiVoiceProvider,
  type AssetUpload,
  type ChatTurn,
  type ConversationRead,
  type PodcastProgress,
  type SpeakChapterRequest,
  type StartedPodcast,
  type StartPodcastRequest,
  type VoiceSessionLink,
  type CopyPresence,
  type CopyRemoval,
  type DubOutputs,
  type DubProgress,
  type DubStatus,
  type GenerationFailure,
  type GenerationProgress,
  type GenerationStatus,
  type MusicRequest,
  type IsolatedAudio,
  type IsolateRequest,
  type OwnVoiceRequest,
  type SoundEffectRequest,
  type SpeakRequest,
  type SpokenAudio,
  type StartDubRequest,
  type StartedDub,
  type StartedGeneration,
  type StartImageRequest,
  type StartVideoRequest,
  type StreamedFile,
  type StreamedMedia,
  type VoiceSample,
  type Transcript,
  type TranscribeRequest,
  type TranscriptWord,
  type UploadedAsset,
} from './ai-voice-provider';

/** The settings of the adapter, all from the environment. */
export const AI_VOICE_ENV = {
  baseUrl: 'AI_VOICE_BASE_URL',
  apiKey: 'AI_VOICE_API_KEY',
  voices: 'AI_VOICE_VOICES',
  model: 'AI_VOICE_MODEL',
  quickModel: 'AI_VOICE_QUICK_MODEL',
  timeoutMs: 'AI_VOICE_TIMEOUT_MS',
  musicTimeoutMs: 'AI_VOICE_MUSIC_TIMEOUT_MS',
  fileTimeoutMs: 'AI_VOICE_FILE_TIMEOUT_MS',
  transcribeModel: 'AI_VOICE_TRANSCRIBE_MODEL',
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * How long a Music track call may run (AITOOLS-03). NO long real run has
 * happened (only a 3 second track), so this is set from the longest track the
 * Hub allows, not from a measured time: a track of up to 5 minutes
 * (`ai.music_max_seconds`, 300) in at most 10 minutes, which stays inside the
 * 30 minutes after which the sweep gives a job's points back
 * (`points.job_max_run_minutes`). A real run sets it. The call is made with
 * `node:http(s)`, not `fetch`, because Node's `fetch` ends a call that has sent
 * no answer in 300 seconds whatever this says (undici's own header wait).
 */
export const DEFAULT_MUSIC_TIMEOUT_MS = 600_000;
/**
 * How long a Captions or Clean audio call may run (AITOOLS-04). NO real run
 * has happened, so this is set from the longest file the plan allows, not from
 * a measured time: 10 minutes of audio (`points.max_audio_min_per_job`) in at
 * most 10 minutes, inside the 30 minutes after which the sweep gives a job's
 * points back. A real run sets it. Like the Music call, these calls are made
 * with `node:http(s)` so Node's own 300 second wait for a first answer never
 * cuts them short.
 */
export const DEFAULT_FILE_TIMEOUT_MS = 600_000;
/**
 * The provider's speech to text model, for Captions (AITOOLS-04):
 * `scribe_v2` is the model the provider's documentation names for the route
 * (docs/elevenlabs/API-FACTS.md, "Speech to text"). A builder's name only; no
 * person sees it (R-68). `AI_VOICE_TRANSCRIBE_MODEL` changes it.
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'scribe_v2';
/** The most a transcript answer may be: a request bound, not a product figure. */
const MAX_JSON_BYTES = 32 * 1024 * 1024;
/**
 * The provider's faster text-to-speech model, for Quick voice (AITOOLS-02):
 * `eleven_flash_v2_5` in the account's model list (docs/elevenlabs/API-FACTS.md,
 * "Text to speech"). A builder's name only; no person sees it (R-68).
 */
export const DEFAULT_QUICK_MODEL = 'eleven_flash_v2_5';
/** The most audio one job may bring back: a request bound, not a product figure. */
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
/** How long the links to the voices' samples are kept before the provider's list is read again (AITOOLS-07). */
const SAMPLES_KEPT_MS = 60 * 60_000;
/** The most a voice's sample may be: a request bound, not a product figure. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Reads the provider's voice list (`GET /v1/voices`, real answer 24 Oct 2026:
 * `{ voices: [{ voice_id, name, category, preview_url, ... }] }`) into one https
 * link per listed voice, by WAWU voice id. A voice the list does not hold, or
 * holds with no https link, has no sample.
 */
export function sampleLinksFrom(
  body: unknown,
  catalogue: readonly { id: string; providerVoiceId: string }[],
  /** True only when the provider's own address is plain http (the local stand-in): then its links are too. */
  allowHttp = false,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const list = (body as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(list)) return out;
  const byProviderId = new Map<string, string>();
  for (const item of list as unknown[]) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (typeof o.voice_id !== 'string' || typeof o.preview_url !== 'string')
      continue;
    const shape = allowHttp ? /^https?:\/\/[^\s/]+\// : /^https:\/\/[^\s/]+\//;
    if (!shape.test(o.preview_url) || o.preview_url.length > 500) continue;
    byProviderId.set(o.voice_id, o.preview_url);
  }
  for (const v of catalogue) {
    const link = byProviderId.get(v.providerVoiceId);
    if (link) out.set(v.id, link);
  }
  return out;
}

/** A language tag as the dubbing route takes it: `yo`, `fil`, `pt-BR`. */
const DUB_LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
/** The shape of an id the provider gives (a project, a language): kept to this before it is put in a path or a note. */
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** The most a subtitle file may be: a request bound, not a product figure. */
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const DUB_STATUSES: readonly DubStatus[] = [
  'queued',
  'processing',
  'completed',
  'stale',
  'failed',
];

/** The types the Studio picture and video tools may hand back, and the plain file name each upload is sent under (AITOOLS-09, AITOOLS-10). */
const ASSET_FILE_NAME: Record<string, string> = {
  'image/png': 'photo.png',
  'image/jpeg': 'photo.jpg',
  'image/webp': 'photo.webp',
  'audio/mpeg': 'speech.mp3',
  'audio/wav': 'speech.wav',
};
/** The failure reasons a generation answers (docs/elevenlabs/API-FACTS.md, "Make an image"). */
const GENERATION_FAILURES: readonly GenerationFailure[] = [
  'moderated',
  'timeout',
  'model_error',
  'invalid_parameters',
  'dependency_failed',
  'charging_failed',
  'internal_error',
];
const GENERATION_STATUSES: readonly GenerationStatus[] = [
  'pending',
  'generating',
  'completed',
  'failed',
];
/** A model name the Hub sends: the settings check it, and it is checked again before it goes into a request. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,60}$/;
/** The most an answer that starts or reads a generation may be: a request bound. */
const MAX_GENERATION_JSON_BYTES = 256 * 1024;

/** The redirects the Music call follows, like `fetch`: up to three. */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** What Node's `fetch` sends as `user-agent`; the Music call sends the same. */
const FETCH_USER_AGENT = 'node';

/** The place a redirect points to, or null when there is none to follow (no `location`, not http or https). */
function redirectTarget(from: URL, location: string | undefined): URL | null {
  if (!location) return null;
  try {
    const next = new URL(location, from);
    return next.protocol === 'http:' || next.protocol === 'https:'
      ? next
      : null;
  } catch {
    return null;
  }
}

/** What a non-2xx answer means: a 429 or 5xx can be tried again (`unavailable`), any other refusal cannot (`rejected`). The status rides on the error for the job's record. */
function failureForStatus(status: number): AiVoiceProviderError {
  const retryable = status === 429 || status >= 500;
  return new AiVoiceProviderError(
    retryable ? 'unavailable' : 'rejected',
    `status ${status}`,
    status,
  );
}

interface CatalogueEntry extends AiVoice {
  providerVoiceId: string;
}

/**
 * Reads `AI_VOICE_VOICES`: a JSON list of `{ id, name, description,
 * providerVoiceId }`. Anything else is no list (the tool then reads as not
 * configured) and the reason is logged without the value.
 */
export function parseVoiceCatalogue(raw: string | undefined): {
  voices: CatalogueEntry[];
  problem: string | null;
} {
  if (!raw || raw.trim() === '') return { voices: [], problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { voices: [], problem: 'is not JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { voices: [], problem: 'is not a list' };
  }
  const out: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const item of parsed as unknown[]) {
    const o = (item ?? {}) as Record<string, unknown>;
    const ok = (v: unknown): v is string =>
      typeof v === 'string' && v.trim() !== '' && v.length <= 200;
    if (
      !ok(o.id) ||
      !ok(o.name) ||
      !ok(o.providerVoiceId) ||
      typeof o.description !== 'string' ||
      !/^[a-z0-9_-]{1,40}$/.test(o.id) ||
      seen.has(o.id)
    ) {
      return { voices: [], problem: 'has an entry that is not valid' };
    }
    seen.add(o.id);
    out.push({
      id: o.id,
      name: o.name,
      description: o.description.slice(0, 200),
      providerVoiceId: o.providerVoiceId,
    });
  }
  return { voices: out, problem: null };
}

/**
 * A request body that is read from a stream as it is sent (a person's file on
 * its way to the provider): it can be opened once. `sent` is called when the
 * last byte is written or the call has an answer; `abort` when the call is
 * given up. Both hand back the file's place at the read gate and destroy the
 * stream; either may be called again.
 */
interface StreamedBody {
  length: number;
  open(): Readable | null;
  sent(): void;
  abort(): void;
}

/**
 * The adapter that speaks to the provider over HTTPS: one request per job,
 * `POST {base}/v1/text-to-speech/{voice}` with the key in `xi-api-key`, the
 * text in a JSON body and the audio (`audio/mpeg`) in the answer.
 *
 * Sound effect and Music track (AITOOLS-03) are the same kind of call:
 * `POST {base}/v1/sound-generation` and `POST {base}/v1/music`, a JSON body, the
 * audio in the answer; Music has its own longer timeout, and is the one call
 * made without `fetch` (see `postForAudioLong`).
 *
 * NOT RUN against the real provider: its key is the owner's and is not on any
 * build machine. It is run against a local stand-in with the same wire shape
 * (`scripts/dev/voice-standin.cjs`). The check that unblocks it: a provider
 * key set on the Hub (`AI_VOICE_API_KEY`, with `AI_VOICE_BASE_URL` and
 * `AI_VOICE_VOICES`).
 *
 * No host is built in: with `AI_VOICE_BASE_URL` unset the tool is off, so
 * nothing can call out by accident.
 */
@Injectable()
export class HttpVoiceProvider implements AiVoiceProvider {
  private readonly logger = new Logger(HttpVoiceProvider.name);
  private readonly baseUrl: string | null;
  private readonly apiKey: string | null;
  private readonly model: string | null;
  private readonly quickModel: string;
  private readonly timeoutMs: number;
  private readonly musicTimeoutMs: number;
  private readonly fileTimeoutMs: number;
  private readonly transcribeModel: string;
  private readonly catalogue: readonly CatalogueEntry[];

  constructor(config: ConfigService) {
    const base = (config.get<string>(AI_VOICE_ENV.baseUrl) ?? '').trim();
    this.baseUrl = /^https?:\/\/[^\s/]+/.test(base)
      ? base.replace(/\/+$/, '')
      : null;
    this.apiKey =
      (config.get<string>(AI_VOICE_ENV.apiKey) ?? '').trim() || null;
    this.model = (config.get<string>(AI_VOICE_ENV.model) ?? '').trim() || null;
    this.quickModel =
      (config.get<string>(AI_VOICE_ENV.quickModel) ?? '').trim() ||
      DEFAULT_QUICK_MODEL;
    const t = Number(config.get<string>(AI_VOICE_ENV.timeoutMs));
    this.timeoutMs = Number.isFinite(t) && t >= 1000 ? t : DEFAULT_TIMEOUT_MS;
    const mt = Number(config.get<string>(AI_VOICE_ENV.musicTimeoutMs));
    this.musicTimeoutMs =
      Number.isFinite(mt) && mt >= 1000 ? mt : DEFAULT_MUSIC_TIMEOUT_MS;
    const ft = Number(config.get<string>(AI_VOICE_ENV.fileTimeoutMs));
    this.fileTimeoutMs =
      Number.isFinite(ft) && ft >= 1000 ? ft : DEFAULT_FILE_TIMEOUT_MS;
    this.transcribeModel =
      (config.get<string>(AI_VOICE_ENV.transcribeModel) ?? '').trim() ||
      DEFAULT_TRANSCRIBE_MODEL;
    const { voices, problem } = parseVoiceCatalogue(
      config.get<string>(AI_VOICE_ENV.voices),
    );
    if (problem) {
      this.logger.warn(
        `${AI_VOICE_ENV.voices} ${problem}: AI voice tools stay off.`,
      );
    }
    this.catalogue = voices;
    if (!this.configured) {
      this.logger.warn(
        `AI voice tools (VoiceOver, Quick voice) are off (${AI_VOICE_ENV.baseUrl}, ${AI_VOICE_ENV.apiKey} and ${AI_VOICE_ENV.voices} are all needed; Sound effect and Music track need only the first two).`,
      );
    }
  }

  get configured(): boolean {
    return (
      this.baseUrl !== null && this.apiKey !== null && this.catalogue.length > 0
    );
  }

  /**
   * Sound effect and Music track use no voice, so a host and a key are enough
   * for them, even when `AI_VOICE_VOICES` is empty (AITOOLS-03 round 2).
   */
  get promptToolsConfigured(): boolean {
    return this.baseUrl !== null && this.apiKey !== null;
  }

  /** Captions and Clean audio take a file and use no voice: a host and a key are enough (AITOOLS-04). */
  get fileToolsConfigured(): boolean {
    return this.baseUrl !== null && this.apiKey !== null;
  }

  /** The Studio API (Podcast maker) and the agents (Receptionist) need only a host and a key (AITOOLS-13, AITOOLS-06). */
  get podcastConfigured(): boolean {
    return this.baseUrl !== null && this.apiKey !== null;
  }

  get agentsConfigured(): boolean {
    return this.baseUrl !== null && this.apiKey !== null;
  }

  /** The Studio picture and video tools use no voice either: a host and a key are enough (AITOOLS-09, AITOOLS-10). */
  get mediaToolsConfigured(): boolean {
    return this.baseUrl !== null && this.apiKey !== null;
  }

  voices(): readonly AiVoice[] {
    return this.catalogue.map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));
  }

  async speak(
    req: SpeakRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    const id = this.voiceIdFor(req);
    return this.synthesize(id, req.text, opts.signal);
  }

  /**
   * The provider's id for a voice a request names: the saved clone's own id when the Hub read one from the person's
   * row (AITOOLS-11), else the catalogue entry of the WAWU id. Not available when the tools are off or the voice is
   * unknown.
   */
  private voiceIdFor(req: {
    voiceId: string;
    providerVoiceId?: string;
  }): string {
    if (req.providerVoiceId !== undefined) {
      if (!this.promptToolsConfigured || !PROVIDER_ID.test(req.providerVoiceId))
        throw new AiVoiceProviderError('rejected', 'voice is not available');
      return req.providerVoiceId;
    }
    const voice = this.catalogue.find((v) => v.id === req.voiceId);
    if (!this.configured || !voice || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'voice is not available');
    return voice.providerVoiceId;
  }

  async speakQuick(
    req: SpeakRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    return this.synthesize(
      this.voiceIdFor(req),
      req.text,
      opts.signal,
      this.quickModel,
    );
  }

  async makeSoundEffect(
    req: SoundEffectRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (!this.promptToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'sound is not available');
    return this.postForAudio(
      '/v1/sound-generation',
      {
        text: req.prompt,
        ...(req.durationSeconds === null
          ? {}
          : { duration_seconds: req.durationSeconds }),
      },
      this.timeoutMs,
      opts.signal,
    );
  }

  async makeMusic(
    req: MusicRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (!this.promptToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'music is not available');
    return this.postForAudioLong(
      '/v1/music',
      {
        prompt: req.prompt,
        ...(req.lengthSeconds === null
          ? {}
          : { music_length_ms: Math.round(req.lengthSeconds * 1000) }),
        ...(req.instrumental ? { force_instrumental: true } : {}),
      },
      this.musicTimeoutMs,
      opts.signal,
    );
  }

  async previewName(
    req: { text: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    // The studio voice is the first one the Hub lists.
    const studio = this.catalogue[0];
    if (!this.configured || !studio || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'voice is not available');
    return this.synthesize(studio.providerVoiceId, req.text, opts.signal);
  }

  /**
   * One run in a person's own voice: `POST {base}/v1/voices/add` (the sample as
   * a multipart file, answering the new voice's id), the same text-to-speech
   * call as `speak` with that id, then `DELETE {base}/v1/voices/{id}` so the
   * provider keeps no copy of the voice. The delete is tried even when the
   * speech failed, and a failed delete is logged without the id.
   */
  async speakInOwnVoice(
    req: OwnVoiceRequest,
    opts: {
      signal?: AbortSignal;
      handOver?: (providerVoiceId: string) => Promise<boolean>;
    } = {},
  ): Promise<SpokenAudio> {
    if (!this.configured || this.baseUrl === null || this.apiKey === null)
      throw new AiVoiceProviderError('rejected', 'voice is not available');
    const voiceId = await this.addVoice(req.sample, opts.signal);
    // AITOOLS-07: the caller may take over the voice's removal (it notes the id
    // on the job and deletes the voice with a retry and a sweep). Only a clean
    // `true` hands it over; the adapter removes the voice itself otherwise.
    let handedOver = false;
    if (opts.handOver) {
      try {
        handedOver = (await opts.handOver(voiceId)) === true;
      } catch {
        handedOver = false;
      }
    }
    try {
      return await this.synthesize(voiceId, req.text, opts.signal);
    } finally {
      if (!handedOver) await this.removeVoice(voiceId);
    }
  }

  async deleteOwnVoice(providerVoiceId: string): Promise<CopyRemoval> {
    if (this.baseUrl === null || this.apiKey === null) return 'failed';
    return this.removeItem(`/v1/voices/${encodeURIComponent(providerVoiceId)}`);
  }

  private samplesAt = 0;
  private sampleLinks: ReadonlyMap<string, string> = new Map();
  private readonly sampleAudio = new Map<
    string,
    { at: number; audio: SpokenAudio }
  >();

  async samples(): Promise<ReadonlySet<string>> {
    return new Set((await this.links()).keys());
  }

  /** The provider's list read at most once an hour, as a map of WAWU voice id to the provider's own link. */
  private async links(): Promise<ReadonlyMap<string, string>> {
    if (!this.configured || this.baseUrl === null || this.apiKey === null)
      return new Map();
    if (Date.now() - this.samplesAt < SAMPLES_KEPT_MS) return this.sampleLinks;
    // Set first so a slow or failing provider is asked once an hour, not once per catalogue read.
    this.samplesAt = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/v1/voices?page_size=100`, {
        headers: { 'xi-api-key': this.apiKey },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        return this.sampleLinks;
      }
      this.sampleLinks = sampleLinksFrom(
        (await res.json()) as unknown,
        this.catalogue,
        this.baseUrl.startsWith('http://'),
      );
    } catch {
      // The catalogue is served without samples; the next read after the hour tries again.
    }
    return this.sampleLinks;
  }

  async sample(voiceId: string): Promise<SpokenAudio | null> {
    const kept = this.sampleAudio.get(voiceId);
    if (kept && Date.now() - kept.at < SAMPLES_KEPT_MS) return kept.audio;
    const link = (await this.links()).get(voiceId);
    if (!link) return null;
    try {
      const res = await fetch(link, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        return null;
      }
      const type = (res.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const bytes = Buffer.from(await res.arrayBuffer());
      if (
        bytes.length === 0 ||
        bytes.length > MAX_PREVIEW_BYTES ||
        !(AI_AUDIO_CONTENT_TYPES as readonly string[]).includes(type)
      )
        return null;
      const audio: SpokenAudio = {
        audio: bytes,
        contentType: type as SpokenAudio['contentType'],
      };
      this.sampleAudio.set(voiceId, { at: Date.now(), audio });
      return audio;
    } catch {
      return null;
    }
  }

  private signalFor(
    outer?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): AbortSignal {
    return outer
      ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
  }

  private async addVoice(
    sample: OwnVoiceRequest['sample'],
    outer?: AbortSignal,
  ): Promise<string> {
    const form = new FormData();
    form.append('name', 'wawu-voice-intro');
    form.append(
      'files',
      new Blob([new Uint8Array(sample.audio)], { type: sample.contentType }),
      'sample',
    );
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/voices/add`, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey ?? '' },
        body: form,
        signal: this.signalFor(outer),
      });
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      const retryable = res.status === 429 || res.status >= 500;
      throw new AiVoiceProviderError(
        retryable ? 'unavailable' : 'rejected',
        `status ${res.status}`,
      );
    }
    let id: unknown;
    try {
      id = ((await res.json()) as { voice_id?: unknown }).voice_id;
    } catch {
      throw new AiVoiceProviderError('unavailable', 'not a voice');
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
      throw new AiVoiceProviderError('unavailable', 'not a voice');
    return id;
  }

  private async removeVoice(providerVoiceId: string): Promise<void> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/voices/${encodeURIComponent(providerVoiceId)}`,
        {
          method: 'DELETE',
          headers: { 'xi-api-key': this.apiKey ?? '' },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok)
        this.logger.warn(`a one-run voice was not removed (${res.status})`);
    } catch {
      this.logger.warn('a one-run voice was not removed (no answer)');
    }
  }

  /** One text-to-speech call; `model` is the quick model for Quick voice, else `AI_VOICE_MODEL` when set. */
  private synthesize(
    providerVoiceId: string,
    text: string,
    outer?: AbortSignal,
    model: string | null = this.model,
  ): Promise<SpokenAudio> {
    return this.postForAudio(
      `/v1/text-to-speech/${encodeURIComponent(providerVoiceId)}`,
      { text, ...(model ? { model_id: model } : {}) },
      this.timeoutMs,
      outer,
    );
  }

  /**
   * One call that answers audio: `POST {base}{path}?output_format=mp3_44100_128`
   * with the key in `xi-api-key` and a JSON body. A 429 or 5xx, no answer, a
   * cut-off or a reply that is not audio is `unavailable`; any other 4xx is
   * `rejected`. The provider's reply and the person's words never go into an
   * error message.
   */
  private async postForAudio(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<SpokenAudio> {
    const signal = this.signalFor(outer, timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'audio/mpeg',
          'xi-api-key': this.apiKey ?? '',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      // A timeout, a refused connection or a broken one: the text is not in
      // this message, and neither is the provider's reply.
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      // Drain the reply without keeping it, so the connection is freed.
      await res.arrayBuffer().catch(() => undefined);
      throw failureForStatus(res.status);
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('audio/'))
      throw new AiVoiceProviderError('unavailable', 'not audio');
    let audio: Buffer;
    try {
      audio = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new AiVoiceProviderError('unavailable', 'answer cut off');
    }
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES)
      throw new AiVoiceProviderError('unavailable', 'audio size');
    return { audio, contentType: 'audio/mpeg' };
  }

  /**
   * The Music call (AITOOLS-03 round 2): the same request and the same
   * answers as `postForAudio`, but over `node:http(s)`, because Node's `fetch`
   * gives up on a call that has sent no answer in 300 seconds (undici's own
   * header wait, and a body wait of the same length), whatever
   * `AI_VOICE_MUSIC_TIMEOUT_MS` says. Here the one deadline is `timeoutMs`,
   * from the moment the request is sent until the whole audio is read; a
   * plain `setTimeout` holds it (nothing collects it), and at the deadline the
   * connection is destroyed. A new connection per call (`agent: false`): a
   * track call is rare and long. The provider's reply and the person's words
   * never go into an error message.
   *
   * Like `fetch` (round 3): it sends the `user-agent` fetch sends, and it
   * follows up to `MAX_REDIRECTS` redirects (301, 302, 303, 307, 308) inside
   * the one deadline. A 307 or 308 repeats the same POST with the same body;
   * a 301, 302 or 303 becomes a GET with no body, as `fetch` does it. The key
   * header goes on every hop, as `fetch` sends it. A fourth redirect, one
   * with no usable `location`, or one to a scheme other than http(s) is
   * answered like any other status (`failureForStatus`).
   */
  private async postForAudioLong(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<SpokenAudio> {
    const done = await this.longCall({
      path,
      query: '?output_format=mp3_44100_128',
      contentType: 'application/json',
      payload: Buffer.from(JSON.stringify(body)),
      accept: 'audio/mpeg',
      typeOk: (type) => type.startsWith('audio/'),
      notOkMessage: 'not audio',
      maxBytes: MAX_AUDIO_BYTES,
      timeoutMs,
      outer,
    });
    return { audio: done.body, contentType: 'audio/mpeg' };
  }

  /**
   * One request with a body that can run for a long time, over `node:http(s)`
   * (see `postForAudioLong`): the one deadline `timeoutMs`, up to
   * `MAX_REDIRECTS` redirects, a new connection per call. Used by the Music
   * call (a JSON body, audio back) and by Captions and Clean audio (a
   * multipart body with the person's file, JSON or audio back). The answer
   * must be a 2xx whose content type `typeOk` accepts and whose size is
   * between 1 byte and `maxBytes`. The provider's reply and the person's
   * file or words never go into an error message.
   */
  private longCall(spec: {
    path: string;
    query: string;
    contentType: string;
    payload: Buffer | StreamedBody;
    accept: string;
    typeOk: (type: string) => boolean;
    notOkMessage: string;
    maxBytes: number;
    timeoutMs: number;
    outer?: AbortSignal;
  }): Promise<{
    body: Buffer;
    type: string;
    headers: IncomingHttpHeaders;
  }> {
    const { payload, timeoutMs, outer } = spec;
    const first = new URL(`${this.baseUrl}${spec.path}${spec.query}`);
    type Done = { body: Buffer; type: string; headers: IncomingHttpHeaders };
    return new Promise<Done>((resolve, reject) => {
      let settled = false;
      /** The request of the hop now running; an earlier hop's events are ignored. */
      let req: ClientRequest | null = null;
      const onAbort = () =>
        end(new AiVoiceProviderError('unavailable', 'no answer'));
      const timer = setTimeout(onAbort, timeoutMs);
      /** Ends the call once: the answer, or the error; either way nothing stays open. */
      const end = (outcome: Done | AiVoiceProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outer?.removeEventListener('abort', onAbort);
        if (outcome instanceof AiVoiceProviderError) {
          reject(outcome);
          req?.destroy();
          if (!Buffer.isBuffer(payload)) payload.abort();
        } else {
          resolve(outcome);
          if (!Buffer.isBuffer(payload)) payload.sent();
        }
      };
      /** One hop: a POST with the body, or (after 301, 302, 303) a GET without. */
      const attempt = (url: URL, withBody: boolean, redirects: number) => {
        const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
        let mine: ClientRequest;
        try {
          mine = send(
            url,
            {
              method: withBody ? 'POST' : 'GET',
              agent: false,
              headers: {
                ...(withBody
                  ? {
                      'content-type': spec.contentType,
                      'content-length': payload.length,
                    }
                  : {}),
                accept: spec.accept,
                'user-agent': FETCH_USER_AGENT,
                'xi-api-key': this.apiKey ?? '',
              },
            },
            (res) => {
              if (mine !== req || settled) return void res.destroy();
              const status = res.statusCode ?? 0;
              if (REDIRECT_STATUSES.has(status)) {
                // Leave this hop's answer unread: nothing in it is wanted.
                res.on('error', () => undefined);
                res.destroy();
                const next = redirectTarget(url, res.headers.location);
                if (next === null || redirects >= MAX_REDIRECTS)
                  return end(failureForStatus(status));
                const again = withBody && (status === 307 || status === 308);
                // A streamed file has been read once and is gone: a redirect
                // that asks for the body again cannot be followed.
                if (again && !Buffer.isBuffer(payload))
                  return end(failureForStatus(status));
                return attempt(next, again, redirects + 1);
              }
              if (status < 200 || status > 299)
                return end(failureForStatus(status));
              const type = String(
                res.headers['content-type'] ?? '',
              ).toLowerCase();
              if (!spec.typeOk(type))
                return end(
                  new AiVoiceProviderError('unavailable', spec.notOkMessage),
                );
              const chunks: Buffer[] = [];
              let size = 0;
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > spec.maxBytes)
                  return end(
                    new AiVoiceProviderError('unavailable', 'answer size'),
                  );
                chunks.push(chunk);
              });
              res.on('end', () => {
                if (size === 0)
                  return end(
                    new AiVoiceProviderError('unavailable', 'answer size'),
                  );
                end({
                  body: Buffer.concat(chunks),
                  type,
                  headers: res.headers,
                });
              });
              const cutOff = () =>
                end(new AiVoiceProviderError('unavailable', 'answer cut off'));
              res.on('error', cutOff);
              res.on('close', () => {
                if (!res.complete) cutOff();
              });
            },
          );
        } catch {
          return end(new AiVoiceProviderError('unavailable', 'no answer'));
        }
        req = mine;
        mine.on('error', () => {
          if (mine === req)
            end(new AiVoiceProviderError('unavailable', 'no answer'));
        });
        if (!withBody) mine.end();
        else if (Buffer.isBuffer(payload)) mine.end(payload);
        else {
          const body = payload.open();
          if (body === null)
            return end(new AiVoiceProviderError('unavailable', 'no answer'));
          body.on('error', () => {
            if (mine === req)
              end(new AiVoiceProviderError('unavailable', 'no answer'));
          });
          // The last byte is written: the file no longer holds the Hub's place.
          mine.on('finish', () => payload.sent());
          body.pipe(mine);
        }
      };
      if (outer?.aborted) return onAbort();
      outer?.addEventListener('abort', onAbort, { once: true });
      attempt(first, true, 0);
    });
  }

  /**
   * A multipart body with the person's file and plain fields, built by hand
   * (the long call sends bytes). `fileField` is the field that holds the file.
   * The file's name is a fixed word, never the person's own. A file in memory
   * is joined into one buffer; a streamed file (AITOOLS-04 round 4) is sent on
   * as it arrives, framed by a head and a tail of a few hundred bytes, so the
   * Hub holds only the stream's own buffers (about 64 KB) however big it is.
   */
  private multipart(
    fields: Record<string, string>,
    fileField: string,
    file: { audio: Buffer; contentType: string } | StreamedFile,
    fileName = 'recording',
  ): { contentType: string; payload: Buffer | StreamedBody } {
    const boundary = `----wawu${randomBytes(16).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields))
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    if (!('stream' in file))
      return {
        contentType,
        payload: Buffer.concat([...parts, file.audio, tail]),
      };
    const head = Buffer.concat(parts);
    const streamed = file;
    let opened = false;
    return {
      contentType,
      payload: {
        length: head.length + streamed.bytes + tail.length,
        open: () => {
          if (opened) return null;
          opened = true;
          return Readable.from(
            (async function* () {
              yield head;
              let n = 0;
              for await (const chunk of streamed.stream as AsyncIterable<Buffer>) {
                n += chunk.length;
                if (n > streamed.bytes)
                  throw new Error('the file is longer than it said');
                yield chunk;
              }
              if (n !== streamed.bytes) throw new Error('the file ended early');
              yield tail;
            })(),
            { objectMode: false },
          );
        },
        sent: () => streamed.sent(),
        abort: () => streamed.sent(),
      },
    };
  }

  async transcribe(
    req: TranscribeRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Transcript> {
    if (!this.fileToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'captions are not available');
    const form = this.multipart(
      {
        model_id: this.transcribeModel,
        timestamps_granularity: 'word',
        ...(req.languageCode ? { language_code: req.languageCode } : {}),
      },
      'file',
      req.file,
    );
    const done = await this.longCall({
      path: '/v1/speech-to-text',
      query: '',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'application/json',
      typeOk: (type) => type.startsWith('application/json'),
      notOkMessage: 'not a transcript',
      maxBytes: MAX_JSON_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    return parseTranscript(done.body);
  }

  deleteTranscript(id: string): Promise<CopyRemoval> {
    return this.removeItem(
      `/v1/speech-to-text/transcripts/${encodeURIComponent(id)}`,
    );
  }

  async transcriptPresence(id: string): Promise<CopyPresence> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/speech-to-text/transcripts/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: { 'xi-api-key': this.apiKey ?? '' },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      // Only the status matters; the body (a person's words) is dropped unopened.
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return 'present';
      return res.status === 404 ? 'absent' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async isolateVoice(
    req: IsolateRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<IsolatedAudio> {
    if (!this.fileToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'cleaning is not available');
    const form = this.multipart({}, 'audio', req.file);
    const done = await this.longCall({
      path: '/v1/audio-isolation',
      query: '',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'audio/*',
      typeOk: (type) => type.startsWith('audio/'),
      notOkMessage: 'not audio',
      maxBytes: MAX_AUDIO_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    // The id of the item the provider keeps comes in the `audio-isolation-id`
    // header (seen on the real provider, 24 Oct 2026; it sends no `history-item-id`).
    const historyId = done.headers['audio-isolation-id'];
    return {
      audio: done.body,
      contentType: done.type.split(';')[0].trim(),
      historyId:
        typeof historyId === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(historyId)
          ? historyId
          : null,
    };
  }

  deleteIsolation(id: string): Promise<CopyRemoval> {
    return this.removeItem(
      `/v1/audio-isolation/history/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Starts a dub (AITOOLS-05): `POST /v1/dubbing/project`, multipart: `file`
   * (the person's, streamed behind the read gate like Captions' and Clean
   * audio's), `target_language` (the shortcut that also queues the first
   * language) and `source_language` when the person gave it. The answer (201) is
   * small: `project_id` and `language_ids`. Only the standard dub is built, so no
   * `model_id` is sent (the provider's default is `dubbing_v2`).
   */
  async startDub(
    req: StartDubRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<StartedDub> {
    if (!this.fileToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'dubbing is not available');
    // The language tags go into a multipart field by hand: only a tag is allowed.
    if (
      !DUB_LANGUAGE_TAG.test(req.targetLanguage) ||
      (req.sourceLanguage !== null &&
        !DUB_LANGUAGE_TAG.test(req.sourceLanguage))
    )
      throw new AiVoiceProviderError('rejected', 'language');
    const form = this.multipart(
      {
        target_language: req.targetLanguage,
        ...(req.sourceLanguage ? { source_language: req.sourceLanguage } : {}),
      },
      'file',
      req.file,
    );
    const done = await this.longCall({
      path: '/v1/dubbing/project',
      query: '',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'application/json',
      typeOk: (type) => type.startsWith('application/json'),
      notOkMessage: 'not a project',
      maxBytes: MAX_JSON_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    return parseStartedDub(done.body);
  }

  /** One read of a dub's language target: `GET /v1/dubbing/project/{id}/language/{id}`. */
  async readDub(
    projectId: string,
    languageId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<DubProgress> {
    if (
      !this.fileToolsConfigured ||
      this.baseUrl === null ||
      !PROVIDER_ID.test(projectId) ||
      !PROVIDER_ID.test(languageId)
    )
      throw new AiVoiceProviderError('rejected', 'dubbing is not available');
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': this.apiKey ?? '',
            accept: 'application/json',
          },
          signal: this.signalFor(opts.signal),
        },
      );
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw failureForStatus(res.status);
    }
    let raw: Buffer;
    try {
      raw = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new AiVoiceProviderError('unavailable', 'answer cut off');
    }
    return parseDubProgress(raw);
  }

  /**
   * Fetches the signed links of a finished dub, once (AITOOLS-05). The links
   * are the provider's to name, so each is checked before it is fetched: https
   * (or http to the very host the Hub is configured with, the local stand-in), a
   * name and not an address, no user name in it, no redirect followed. The
   * provider's key is NOT sent (a signed link needs none and may be another
   * host). The audio is read as a stream and stopped at `maxAudioBytes`, and
   * must open with the FLAC marker; the subtitles stop at 2 MB and must open
   * with WEBVTT, else they are dropped (the dub is the audio).
   */
  async fetchDubOutputs(
    links: { audioUrl: string; subtitlesUrl: string | null },
    opts: { maxAudioBytes: number; signal?: AbortSignal },
  ): Promise<DubOutputs> {
    const audio = await this.download(
      links.audioUrl,
      opts.maxAudioBytes,
      opts.signal,
    );
    if (audio.length < 4 || audio.toString('latin1', 0, 4) !== 'fLaC')
      throw new AiVoiceProviderError('unavailable', 'not flac');
    let subtitles: string | null = null;
    if (links.subtitlesUrl) {
      try {
        const text = (
          await this.download(
            links.subtitlesUrl,
            MAX_SUBTITLE_BYTES,
            opts.signal,
          )
        )
          .toString('utf8')
          .replace(/^\uFEFF/, '');
        if (text.startsWith('WEBVTT')) subtitles = text;
      } catch {
        // The subtitles are a help, not the dub: the job goes on without them.
        this.logger.warn('a dub finished without its subtitles');
      }
    }
    return { audio, contentType: 'audio/flac', subtitles };
  }

  /** One signed link, fetched with no key, no redirect and a size stop. */
  private async download(
    link: string,
    maxBytes: number,
    outer?: AbortSignal,
  ): Promise<Buffer> {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new AiVoiceProviderError('unavailable', 'bad link');
    }
    const base = this.baseUrl === null ? null : new URL(this.baseUrl);
    const sameAsProvider =
      base !== null && url.protocol === base.protocol && url.host === base.host;
    const named =
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      !/^\[|^[0-9.]+$/.test(url.hostname) &&
      url.hostname !== 'localhost';
    if (!named && !(sameAsProvider && url.username === ''))
      throw new AiVoiceProviderError('unavailable', 'bad link');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: this.signalFor(outer, this.fileTimeoutMs),
      });
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw failureForStatus(res.status || 502);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new AiVoiceProviderError('unavailable', 'answer size');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AiVoiceProviderError('unavailable', 'answer size');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      if (e instanceof AiVoiceProviderError) throw e;
      throw new AiVoiceProviderError('unavailable', 'answer cut off');
    }
    if (size === 0)
      throw new AiVoiceProviderError('unavailable', 'answer size');
    return Buffer.concat(chunks, size);
  }

  removeDub(projectId: string): Promise<CopyRemoval> {
    if (!PROVIDER_ID.test(projectId)) return Promise.resolve('failed');
    return this.removeItem(
      `/v1/dubbing/project/${encodeURIComponent(projectId)}`,
    );
  }

  async dubPresence(projectId: string): Promise<CopyPresence> {
    if (!PROVIDER_ID.test(projectId)) return 'unknown';
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/dubbing/project/${encodeURIComponent(projectId)}`,
        {
          method: 'GET',
          headers: { 'xi-api-key': this.apiKey ?? '' },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      // Only the status matters; the body is dropped unopened.
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return 'present';
      return res.status === 404 ? 'absent' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ---- Studio pictures and video (AITOOLS-09, AITOOLS-10, R-109) -----------
  // NOT RUN against the real provider (the owner's credits are not bought
  // yet); every path here is run against the stand-in
  // (`scripts/dev/voice-standin.cjs`) with the same wire shape as the
  // provider's file (docs/elevenlabs/API-FACTS.md, "Make an image" and "Make a
  // video, Talking photo").

  /** `POST /v1/assets`, multipart `asset` (the file) and `name`. The answer holds `asset_id`. */
  async uploadAsset(
    req: AssetUpload,
    opts: { signal?: AbortSignal } = {},
  ): Promise<UploadedAsset> {
    if (!this.mediaToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'pictures are not available');
    const type = req.file.contentType;
    const fileName = ASSET_FILE_NAME[type];
    if (!fileName) throw new AiVoiceProviderError('rejected', 'file type');
    const form = this.multipart(
      { name: fileName },
      'asset',
      req.file,
      fileName,
    );
    const done = await this.longCall({
      path: '/v1/assets',
      query: '',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'application/json',
      typeOk: (t) => t.startsWith('application/json'),
      notOkMessage: 'not an asset',
      maxBytes: MAX_GENERATION_JSON_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    return parseUploadedAsset(done.body);
  }

  removeAsset(assetId: string): Promise<CopyRemoval> {
    if (!PROVIDER_ID.test(assetId)) return Promise.resolve('failed');
    return this.removeItem(`/v1/assets/${encodeURIComponent(assetId)}`);
  }

  async startImage(
    req: StartImageRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<StartedGeneration> {
    if (
      !MODEL_ID.test(req.model) ||
      !req.assetIds.every((id) => PROVIDER_ID.test(id))
    )
      throw new AiVoiceProviderError('rejected', 'request');
    return this.startGeneration(
      '/v1/flows/image',
      {
        model_id: req.model,
        prompt: req.prompt,
        aspect_ratio: req.shape,
        resolution: req.resolution,
        ...(req.assetIds.length > 0
          ? {
              images: req.assetIds.map((asset_id) => ({
                type: 'asset',
                asset_id,
              })),
            }
          : {}),
      },
      opts.signal,
    );
  }

  readImage(
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GenerationProgress> {
    return this.readGeneration('/v1/flows/image', id, opts.signal);
  }

  async startVideo(
    req: StartVideoRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<StartedGeneration> {
    if (!MODEL_ID.test(req.model))
      throw new AiVoiceProviderError('rejected', 'request');
    if (req.kind === 'clip') {
      if (
        (req.startFrameAssetId !== null &&
          !PROVIDER_ID.test(req.startFrameAssetId)) ||
        !Number.isInteger(req.seconds) ||
        !clipLengthFits(req.model, req.seconds)
      )
        throw new AiVoiceProviderError('rejected', 'request');
      return this.startGeneration(
        '/v1/flows/video',
        {
          model_id: req.model,
          prompt: req.prompt,
          // A number: the live provider refuses the string its downloaded reference names (VIDEO_MODEL_LENGTHS).
          duration_secs: req.seconds,
          aspect_ratio: req.shape,
          resolution: req.resolution,
          generate_audio: req.withSound,
          ...(req.startFrameAssetId !== null
            ? {
                start_frame: {
                  type: 'asset',
                  asset_id: req.startFrameAssetId,
                },
              }
            : {}),
        },
        opts.signal,
      );
    }
    if (
      !PROVIDER_ID.test(req.imageAssetId) ||
      !PROVIDER_ID.test(req.audioAssetId)
    )
      throw new AiVoiceProviderError('rejected', 'request');
    return this.startGeneration(
      '/v1/flows/video',
      {
        model_id: req.model,
        image: { type: 'asset', asset_id: req.imageAssetId },
        audio: { type: 'asset', asset_id: req.audioAssetId },
        resolution: req.resolution,
      },
      opts.signal,
    );
  }

  readVideo(
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GenerationProgress> {
    return this.readGeneration('/v1/flows/video', id, opts.signal);
  }

  /** One JSON POST that starts a generation: the answer is small, `{ id, status: pending }`. The person's words are never in an error. */
  private async startGeneration(
    path: string,
    body: Record<string, unknown>,
    outer?: AbortSignal,
  ): Promise<StartedGeneration> {
    if (!this.mediaToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'pictures are not available');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'xi-api-key': this.apiKey ?? '',
        },
        body: JSON.stringify(body),
        signal: this.signalFor(outer),
      });
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw failureForStatus(res.status);
    }
    return parseStartedGeneration(await this.smallBody(res));
  }

  private async readGeneration(
    path: string,
    id: string,
    outer?: AbortSignal,
  ): Promise<GenerationProgress> {
    if (
      !this.mediaToolsConfigured ||
      this.baseUrl === null ||
      !PROVIDER_ID.test(id)
    )
      throw new AiVoiceProviderError('rejected', 'pictures are not available');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey ?? '',
          accept: 'application/json',
        },
        signal: this.signalFor(outer),
      });
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw failureForStatus(res.status);
    }
    return parseGenerationProgress(await this.smallBody(res));
  }

  /** A small JSON answer, read whole and bounded. */
  private async smallBody(res: Response): Promise<Buffer> {
    try {
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length > MAX_GENERATION_JSON_BYTES)
        throw new AiVoiceProviderError('unavailable', 'answer size');
      return raw;
    } catch (e) {
      if (e instanceof AiVoiceProviderError) throw e;
      throw new AiVoiceProviderError('unavailable', 'answer cut off');
    }
  }

  async openGeneration(
    link: string,
    opts: {
      maxBytes: number;
      types: readonly string[];
      signal?: AbortSignal;
    },
  ): Promise<StreamedMedia> {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new AiVoiceProviderError('unavailable', 'bad link');
    }
    const base = this.baseUrl === null ? null : new URL(this.baseUrl);
    const sameAsProvider =
      base !== null && url.protocol === base.protocol && url.host === base.host;
    const named =
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      !/^\[|^[0-9.]+$/.test(url.hostname) &&
      url.hostname !== 'localhost';
    if (!named && !(sameAsProvider && url.username === ''))
      throw new AiVoiceProviderError('unavailable', 'bad link');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.signalFor(opts.signal, this.fileTimeoutMs),
    ]);
    let res: Response;
    try {
      // No key: a signed link needs none and may be another host. No redirect.
      res = await fetch(url, { method: 'GET', redirect: 'error', signal });
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw failureForStatus(res.status || 502);
    }
    const type = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const declared = Number(res.headers.get('content-length'));
    const bytes = Number.isFinite(declared) && declared > 0 ? declared : null;
    if (
      !opts.types.includes(type) ||
      (bytes !== null && bytes > opts.maxBytes)
    ) {
      controller.abort();
      await res.body.cancel().catch(() => undefined);
      throw new AiVoiceProviderError('unavailable', 'answer type or size');
    }
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > opts.maxBytes) return done(new Error('answer size'));
        done(null, chunk);
      },
    });
    const source = Readable.fromWeb(
      res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
    );
    source.on('error', (e) => limit.destroy(e));
    source.pipe(limit);
    return {
      contentType: type,
      bytes,
      stream: limit,
      close: () => {
        controller.abort();
        source.destroy();
        limit.destroy();
      },
    };
  }

  // ---- Voice changer, Dialogue, a saved clone, Music for a video, Split a song (AITOOLS-11, AITOOLS-12, R-109) -----
  // NOT RUN against the real provider (the owner's credits are not bought yet); every path is run against the
  // stand-in with the wire shape of the provider's file (docs/elevenlabs/API-FACTS.md, "Studio 2").

  /**
   * One long call whose answer is mp3 audio. The provider's file types the answer `application/octet-stream` (the
   * format rides on `output_format`), the TTS route answers `audio/mpeg`: either is taken, and the bytes themselves
   * must begin like an MP3 file, so a page or a JSON body under an audio label is never stored as audio.
   */
  private async audioCall(spec: {
    path: string;
    contentType: string;
    payload: Parameters<HttpVoiceProvider['longCall']>[0]['payload'];
    timeoutMs: number;
    outer?: AbortSignal;
  }): Promise<SpokenAudio> {
    const done = await this.longCall({
      path: spec.path,
      query: '?output_format=mp3_44100_128',
      contentType: spec.contentType,
      payload: spec.payload,
      accept: 'audio/mpeg',
      typeOk: (type) =>
        type.startsWith('audio/') ||
        type.startsWith('application/octet-stream'),
      notOkMessage: 'not audio',
      maxBytes: MAX_AUDIO_BYTES,
      timeoutMs: spec.timeoutMs,
      outer: spec.outer,
    });
    if (!looksLikeMp3(done.body))
      throw new AiVoiceProviderError('unavailable', 'not audio');
    return { audio: done.body, contentType: 'audio/mpeg' };
  }

  async changeVoice(
    req: ChangeVoiceRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    const id = this.voiceIdFor(req);
    if (!MODEL_ID.test(req.model))
      throw new AiVoiceProviderError('rejected', 'model');
    const form = this.multipart(
      { model_id: req.model, remove_background_noise: 'false' },
      'audio',
      req.file,
    );
    return this.audioCall({
      path: `/v1/speech-to-speech/${encodeURIComponent(id)}`,
      contentType: form.contentType,
      payload: form.payload,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
  }

  async makeDialogue(
    req: DialogueRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (!MODEL_ID.test(req.model))
      throw new AiVoiceProviderError('rejected', 'model');
    const inputs = req.lines.map((line) => ({
      text: line.text,
      voice_id: this.voiceIdFor(line),
    }));
    return this.audioCall({
      path: '/v1/text-to-dialogue',
      contentType: 'application/json',
      payload: Buffer.from(JSON.stringify({ inputs, model_id: req.model })),
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
  }

  async cloneVoice(
    req: CloneVoiceRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ClonedVoice> {
    if (!this.fileToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'voices are not available');
    const form = this.multipart(
      { name: req.name, remove_background_noise: 'false' },
      'files',
      req.file,
      'sample',
    );
    const done = await this.longCall({
      path: '/v1/voices/add',
      query: '',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'application/json',
      typeOk: (type) => type.startsWith('application/json'),
      notOkMessage: 'not a voice',
      maxBytes: MAX_GENERATION_JSON_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    let id: unknown;
    try {
      id = (JSON.parse(done.body.toString('utf8')) as { voice_id?: unknown })
        .voice_id;
    } catch {
      throw new AiVoiceProviderError('unavailable', 'not a voice');
    }
    if (typeof id !== 'string' || !PROVIDER_ID.test(id))
      throw new AiVoiceProviderError('unavailable', 'not a voice');
    return { providerVoiceId: id };
  }

  async makeMusicForVideo(
    req: MusicForVideoRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (!this.fileToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'music is not available');
    // No model is sent: the provider's default is the one Music track uses, so the two stay comparable.
    const form = this.multipart(
      req.description ? { description: req.description } : {},
      'videos',
      req.file,
      'video',
    );
    return this.audioCall({
      path: '/v1/music/video-to-music',
      contentType: form.contentType,
      payload: form.payload,
      timeoutMs: this.musicTimeoutMs,
      outer: opts.signal,
    });
  }

  async splitStems(
    req: SplitStemsRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<StemArchive> {
    if (!this.fileToolsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'splitting is not available');
    const form = this.multipart(
      {
        stem_variation_id: req.parts === 2 ? 'two_stems_v1' : 'six_stems_v1',
      },
      'file',
      req.file,
      'song',
    );
    const done = await this.longCall({
      path: '/v1/music/stem-separation',
      query: '?output_format=mp3_44100_128',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'application/zip, application/octet-stream',
      typeOk: (type) =>
        type.startsWith('application/zip') ||
        type.startsWith('application/octet-stream') ||
        type.startsWith('application/x-zip'),
      notOkMessage: 'not an archive',
      maxBytes: ZIP_LIMITS.maxArchiveBytes,
      timeoutMs: this.musicTimeoutMs,
      outer: opts.signal,
    });
    return { archive: done.body };
  }

  // ---- Audiobook, Podcast maker (AITOOLS-13, R-109) ---------------------------------------------------------------
  // NOT RUN against the real provider (the owner's credits are not bought yet); every path is run against the
  // stand-in with the wire shape of the provider's file (docs/elevenlabs/API-FACTS.md, "Audiobook", "Podcast maker").

  async speakChapter(
    req: SpeakChapterRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    const id = this.voiceIdFor({ voiceId: req.voiceId });
    if (!MODEL_ID.test(req.model))
      throw new AiVoiceProviderError('rejected', 'model');
    // One chapter is a long text on a long call: its own deadline (the file timeout), not the short-text one.
    return this.postForAudioLong(
      `/v1/text-to-speech/${encodeURIComponent(id)}`,
      {
        text: req.text,
        model_id: req.model,
        ...(req.previousText ? { previous_text: req.previousText } : {}),
        ...(req.nextText ? { next_text: req.nextText } : {}),
      },
      this.fileTimeoutMs,
      opts.signal,
    );
  }

  async startPodcast(
    req: StartPodcastRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<StartedPodcast> {
    if (!this.podcastConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'podcasts are not available');
    if (!MODEL_ID.test(req.model) || !/^[a-z]{2}$/.test(req.language))
      throw new AiVoiceProviderError('rejected', 'model or language');
    const host = this.voiceIdFor({ voiceId: req.hostVoiceId });
    const mode =
      req.mode === 'conversation'
        ? {
            type: 'conversation',
            conversation: {
              host_voice_id: host,
              guest_voice_id: this.voiceIdFor({
                voiceId: req.guestVoiceId ?? '',
              }),
            },
          }
        : { type: 'bulletin', bulletin: { host_voice_id: host } };
    const raw = await this.jsonCall(
      'POST',
      '/v1/studio/podcasts',
      {
        model_id: req.model,
        mode,
        source: req.source,
        quality_preset: 'standard',
        duration_scale: req.duration,
        language: req.language,
      },
      opts.signal,
    );
    const project = (raw as { project?: { project_id?: unknown } }).project;
    const id =
      project?.project_id ?? (raw as { project_id?: unknown }).project_id;
    if (typeof id !== 'string' || !PROVIDER_ID.test(id))
      throw new AiVoiceProviderError('unavailable', 'not a project');
    return { projectId: id };
  }

  async readPodcast(
    projectId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<PodcastProgress> {
    if (!this.podcastConfigured || !PROVIDER_ID.test(projectId))
      throw new AiVoiceProviderError('rejected', 'podcasts are not available');
    const raw = (await this.jsonCall(
      'GET',
      `/v1/studio/projects/${encodeURIComponent(projectId)}`,
      undefined,
      opts.signal,
    )) as {
      can_be_downloaded?: unknown;
      project?: { can_be_downloaded?: unknown };
    };
    const flag = raw.can_be_downloaded ?? raw.project?.can_be_downloaded;
    return { ready: flag === true };
  }

  async fetchPodcastAudio(
    projectId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (!this.podcastConfigured || !PROVIDER_ID.test(projectId))
      throw new AiVoiceProviderError('rejected', 'podcasts are not available');
    const listed = (await this.jsonCall(
      'GET',
      `/v1/studio/projects/${encodeURIComponent(projectId)}/snapshots`,
      undefined,
      opts.signal,
    )) as { snapshots?: unknown };
    const snaps = Array.isArray(listed.snapshots)
      ? (listed.snapshots as {
          project_snapshot_id?: unknown;
          created_at_unix?: unknown;
        }[])
      : [];
    const newest = snaps
      .filter(
        (s) =>
          typeof s?.project_snapshot_id === 'string' &&
          PROVIDER_ID.test(s.project_snapshot_id),
      )
      .sort(
        (a, b) =>
          Number(b.created_at_unix ?? 0) - Number(a.created_at_unix ?? 0),
      )[0];
    if (!newest) throw new AiVoiceProviderError('unavailable', 'no snapshot');
    const done = await this.longCall({
      path: `/v1/studio/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(String(newest.project_snapshot_id))}/stream`,
      query: '',
      contentType: 'application/json',
      payload: Buffer.from(JSON.stringify({ convert_to_mpeg: true })),
      accept: 'audio/mpeg',
      // The provider's file types this stream `text/event-stream`; the bytes are what decide (below).
      typeOk: (type) =>
        type.startsWith('audio/') ||
        type.startsWith('application/octet-stream') ||
        type.startsWith('text/event-stream'),
      notOkMessage: 'not audio',
      maxBytes: MAX_AUDIO_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    if (!looksLikeMp3(done.body))
      throw new AiVoiceProviderError('unavailable', 'not audio');
    return { audio: done.body, contentType: 'audio/mpeg' };
  }

  removePodcast(projectId: string): Promise<CopyRemoval> {
    if (!PROVIDER_ID.test(projectId)) return Promise.resolve('failed');
    return this.removeItem(
      `/v1/studio/projects/${encodeURIComponent(projectId)}`,
    );
  }

  // ---- Receptionist (AITOOLS-06, R-109) ---------------------------------------------------------------------------
  // NOT RUN against the real provider. The agent socket's messages follow docs/elevenlabs/API-FACTS.md ("Receptionist:
  // the talking agent"); nothing here reaches a phone number, WhatsApp, a call or a call list.

  /** A small JSON call with the key; the answer is parsed and bounded. A non-2xx is `failureForStatus`. */
  private async jsonCall(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    outer?: AbortSignal,
  ): Promise<unknown> {
    if (this.baseUrl === null || this.apiKey === null)
      throw new AiVoiceProviderError('rejected', 'not available');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'xi-api-key': this.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signalFor(outer),
      });
    } catch {
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw failureForStatus(res.status);
    }
    try {
      return JSON.parse(
        (await this.smallBody(res)).toString('utf8'),
      ) as unknown;
    } catch (e) {
      if (e instanceof AiVoiceProviderError) throw e;
      throw new AiVoiceProviderError('unavailable', 'not json');
    }
  }

  /** The agent as the provider takes it (`conversation_config`, the text-only override on, the longest session set). */
  private agentBody(spec: AgentSpec): Record<string, unknown> {
    if (
      !MODEL_ID.test(spec.llm) &&
      !/^[a-z0-9][a-z0-9._-]{1,60}$/i.test(spec.llm)
    )
      throw new AiVoiceProviderError('rejected', 'model');
    if (!/^[a-z]{2}$/.test(spec.language))
      throw new AiVoiceProviderError('rejected', 'language');
    for (const k of spec.knowledge)
      if (!PROVIDER_ID.test(k.id))
        throw new AiVoiceProviderError('rejected', 'document');
    return {
      name: spec.name,
      conversation_config: {
        agent: {
          first_message: spec.firstMessage,
          language: spec.language,
          prompt: {
            prompt: spec.prompt,
            llm: spec.llm,
            knowledge_base: spec.knowledge.map((k) => ({
              type: k.kind,
              name: k.name,
              id: k.id,
              usage_mode: 'auto',
            })),
          },
        },
        tts: { voice_id: this.voiceIdFor({ voiceId: spec.voiceId }) },
        conversation: { text_only: false },
      },
      platform_settings: {
        overrides: {
          conversation_config_override: { conversation: { text_only: true } },
        },
      },
    };
  }

  async createAgent(
    spec: AgentSpec,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ agentId: string }> {
    if (!this.agentsConfigured)
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    const raw = (await this.jsonCall(
      'POST',
      '/v1/convai/agents/create',
      this.agentBody(spec),
      opts.signal,
    )) as { agent_id?: unknown };
    if (typeof raw.agent_id !== 'string' || !PROVIDER_ID.test(raw.agent_id))
      throw new AiVoiceProviderError('unavailable', 'not an agent');
    return { agentId: raw.agent_id };
  }

  async updateAgent(
    agentId: string,
    spec: AgentSpec,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.agentsConfigured || !PROVIDER_ID.test(agentId))
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    await this.jsonCall(
      'PATCH',
      `/v1/convai/agents/${encodeURIComponent(agentId)}`,
      this.agentBody(spec),
      opts.signal,
    );
  }

  deleteAgent(agentId: string): Promise<CopyRemoval> {
    if (!PROVIDER_ID.test(agentId)) return Promise.resolve('failed');
    return this.removeItem(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
  }

  private knowledgeId(raw: unknown): { id: string } {
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== 'string' || !PROVIDER_ID.test(id))
      throw new AiVoiceProviderError('unavailable', 'not a document');
    return { id };
  }

  async addKnowledgeText(
    req: { name: string; text: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ id: string }> {
    if (!this.agentsConfigured)
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    return this.knowledgeId(
      await this.jsonCall(
        'POST',
        '/v1/convai/knowledge-base/text',
        { text: req.text, name: req.name },
        opts.signal,
      ),
    );
  }

  async addKnowledgeUrl(
    req: { name: string; url: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ id: string }> {
    if (!this.agentsConfigured)
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    return this.knowledgeId(
      await this.jsonCall(
        'POST',
        '/v1/convai/knowledge-base/url',
        { url: req.url, name: req.name },
        opts.signal,
      ),
    );
  }

  async addKnowledgeFile(
    req: { name: string; file: VoiceSample | StreamedFile },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ id: string }> {
    if (!this.agentsConfigured || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    const form = this.multipart(
      { name: req.name },
      'file',
      req.file,
      req.file.contentType === 'application/pdf'
        ? 'document.pdf'
        : 'document.txt',
    );
    const done = await this.longCall({
      path: '/v1/convai/knowledge-base/file',
      query: '',
      contentType: form.contentType,
      payload: form.payload,
      accept: 'application/json',
      typeOk: (type) => type.startsWith('application/json'),
      notOkMessage: 'not a document',
      maxBytes: MAX_GENERATION_JSON_BYTES,
      timeoutMs: this.fileTimeoutMs,
      outer: opts.signal,
    });
    try {
      return this.knowledgeId(JSON.parse(done.body.toString('utf8')));
    } catch (e) {
      if (e instanceof AiVoiceProviderError) throw e;
      throw new AiVoiceProviderError('unavailable', 'not a document');
    }
  }

  deleteKnowledge(id: string): Promise<CopyRemoval> {
    if (!PROVIDER_ID.test(id)) return Promise.resolve('failed');
    return this.removeItem(
      `/v1/convai/knowledge-base/${encodeURIComponent(id)}?force=true`,
    );
  }

  /**
   * A signed link must go to the provider's own host: `wss` to the host the Hub is set up with or a subdomain of it
   * (never an address, `localhost` or a host with a dot at its end), or `ws` to the very host the Hub is set up with
   * (the local stand-in). The provider's key is never sent on it. A link to any other host is "bad link", so an answer
   * naming a stranger's host is never dialled.
   */
  private socketUrl(signed: string): URL {
    let url: URL;
    try {
      url = new URL(signed);
    } catch {
      throw new AiVoiceProviderError('unavailable', 'bad link');
    }
    const base = this.baseUrl === null ? null : new URL(this.baseUrl);
    const named =
      base !== null &&
      url.protocol === 'wss:' &&
      url.username === '' &&
      url.password === '' &&
      !/^\[|^[0-9.]+$/.test(url.hostname) &&
      !url.hostname.endsWith('.') &&
      url.hostname !== 'localhost' &&
      (url.hostname === base.hostname ||
        url.hostname.endsWith(`.${base.hostname}`));
    const sameAsProvider =
      base !== null &&
      url.username === '' &&
      !url.hostname.endsWith('.') &&
      url.host === base.host &&
      url.protocol === (base.protocol === 'https:' ? 'wss:' : 'ws:');
    if (!named && !sameAsProvider)
      throw new AiVoiceProviderError('unavailable', 'bad link');
    return url;
  }

  async askAgent(
    req: { agentId: string; message: string; earlier: readonly ChatTurn[] },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ reply: string }> {
    if (!this.agentsConfigured || !PROVIDER_ID.test(req.agentId))
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    const link = await this.signedLink(req.agentId, false, opts.signal);
    const url = this.socketUrl(link.signedUrl);
    // The earlier messages go on with the new one as plain words: the socket takes one `user_message` at a time.
    const text =
      req.earlier.length === 0
        ? req.message
        : `${req.earlier
            .map((t) => `${t.role === 'person' ? 'Person' : 'You'}: ${t.text}`)
            .join('\n')}\n\nThe person now writes: ${req.message}`;
    return new Promise<{ reply: string }>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url, {
        handshakeTimeout: 15_000,
        maxPayload: 1 << 20,
      });
      const end = (out: { reply: string } | AiVoiceProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        try {
          socket.terminate();
        } catch {
          // already closed
        }
        if (out instanceof AiVoiceProviderError) reject(out);
        else resolve(out);
      };
      const onAbort = () =>
        end(new AiVoiceProviderError('unavailable', 'no answer'));
      const timer = setTimeout(onAbort, this.timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      socket.on('error', () =>
        end(new AiVoiceProviderError('unavailable', 'no answer')),
      );
      socket.on('close', () =>
        end(new AiVoiceProviderError('unavailable', 'answer cut off')),
      );
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'conversation_initiation_client_data',
            conversation_config_override: { conversation: { text_only: true } },
          }),
        );
      });
      let asked = false;
      const ask = () => {
        if (asked) return;
        asked = true;
        socket.send(JSON.stringify({ type: 'user_message', text }));
      };
      socket.on('message', (data) => {
        let event: Record<string, unknown>;
        try {
          const raw = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          event = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === 'ping') {
          const id = (event.ping_event as { event_id?: unknown } | undefined)
            ?.event_id;
          socket.send(JSON.stringify({ type: 'pong', event_id: id }));
        } else if (event.type === 'conversation_initiation_metadata') {
          ask();
        } else if (event.type === 'agent_response') {
          const reply = (
            event.agent_response_event as
              { agent_response?: unknown } | undefined
          )?.agent_response;
          if (typeof reply === 'string' && reply.trim() !== '')
            end({ reply: reply.trim() });
          else end(new AiVoiceProviderError('unavailable', 'empty reply'));
        } else if (event.type === 'error') {
          end(new AiVoiceProviderError('rejected', 'the agent refused'));
        }
      });
    });
  }

  private async signedLink(
    agentId: string,
    withConversation: boolean,
    outer?: AbortSignal,
  ): Promise<VoiceSessionLink> {
    const raw = (await this.jsonCall(
      'GET',
      `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}${withConversation ? '&include_conversation_id=true' : ''}`,
      undefined,
      outer,
    )) as { signed_url?: unknown; conversation_id?: unknown };
    if (typeof raw.signed_url !== 'string')
      throw new AiVoiceProviderError('unavailable', 'not a link');
    let id: unknown = raw.conversation_id;
    if (typeof id !== 'string') {
      try {
        id =
          new URL(raw.signed_url).searchParams.get('conversation_id') ??
          undefined;
      } catch {
        id = undefined;
      }
    }
    if (withConversation && (typeof id !== 'string' || !PROVIDER_ID.test(id)))
      throw new AiVoiceProviderError('unavailable', 'no conversation id');
    return {
      signedUrl: raw.signed_url,
      conversationId: typeof id === 'string' ? id : '',
    };
  }

  async openVoiceSession(
    agentId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<VoiceSessionLink> {
    if (!this.agentsConfigured || !PROVIDER_ID.test(agentId))
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    return this.signedLink(agentId, true, opts.signal);
  }

  async readConversation(
    conversationId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ConversationRead> {
    if (!this.agentsConfigured || !PROVIDER_ID.test(conversationId))
      throw new AiVoiceProviderError('rejected', 'agents are not available');
    const raw = (await this.jsonCall(
      'GET',
      `/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      undefined,
      opts.signal,
    )) as { status?: unknown; metadata?: { call_duration_secs?: unknown } };
    const statuses = [
      'initiated',
      'in-progress',
      'processing',
      'done',
      'failed',
    ];
    const status = statuses.includes(String(raw.status))
      ? (raw.status as ConversationRead['status'])
      : 'processing';
    const secs = raw.metadata?.call_duration_secs;
    return {
      status,
      seconds:
        typeof secs === 'number' && Number.isFinite(secs) && secs >= 0
          ? Math.round(secs)
          : null,
    };
  }

  deleteConversation(conversationId: string): Promise<CopyRemoval> {
    if (!PROVIDER_ID.test(conversationId)) return Promise.resolve('failed');
    return this.removeItem(
      `/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    );
  }

  /**
   * One try at deleting one item the provider keeps. Never throws and never
   * logs (the caller decides what a failed try means: the provider answers
   * 404 for a copy it has not stored yet, so a 404 is not yet "gone").
   */
  private async removeItem(path: string): Promise<CopyRemoval> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': this.apiKey ?? '' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) return 'deleted';
      return res.status === 404 ? 'not_found' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

/**
 * Reads a speech to text answer (docs/elevenlabs/API-FACTS.md): `text`,
 * `words[{text,type,start,end}]`, `audio_duration_secs`, `transcription_id`.
 * An answer with no text field is not a transcript (`unavailable`: the call
 * may be tried again). An empty `text` is a recording with no speech and is
 * a valid transcript.
 */
export function parseTranscript(raw: Buffer): Transcript {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AiVoiceProviderError('unavailable', 'not a transcript');
  }
  if (typeof o?.text !== 'string')
    throw new AiVoiceProviderError('unavailable', 'not a transcript');
  const words: TranscriptWord[] = [];
  if (Array.isArray(o.words)) {
    for (const item of o.words as unknown[]) {
      const w = (item ?? {}) as Record<string, unknown>;
      if (
        typeof w.text === 'string' &&
        typeof w.start === 'number' &&
        typeof w.end === 'number' &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end)
      )
        words.push({
          text: w.text,
          type: typeof w.type === 'string' ? w.type : 'word',
          start: w.start,
          end: w.end,
        });
    }
  }
  const dur = o.audio_duration_secs;
  const id = o.transcription_id;
  return {
    text: o.text,
    words,
    durationSeconds:
      typeof dur === 'number' && Number.isFinite(dur) && dur >= 0 ? dur : null,
    id: typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null,
  };
}

/**
 * Reads the answer that starts a dub (docs/elevenlabs/API-FACTS.md, "Dubbing"):
 * `project_id` and `language_ids`. No project id is no project (`unavailable`:
 * the call may be tried again); a project with no language id is returned with
 * `languageId: null` so the Hub can delete it.
 */
export function parseStartedDub(raw: Buffer): StartedDub {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AiVoiceProviderError('unavailable', 'not a project');
  }
  const id = o?.project_id;
  if (typeof id !== 'string' || !PROVIDER_ID.test(id))
    throw new AiVoiceProviderError('unavailable', 'not a project');
  const ids: unknown[] = Array.isArray(o.language_ids) ? o.language_ids : [];
  const first = ids[0];
  return {
    projectId: id,
    languageId:
      typeof first === 'string' && PROVIDER_ID.test(first) ? first : null,
  };
}

/**
 * Reads a language target (docs/elevenlabs/API-FACTS.md, "Dubbing"): `status`
 * and, once completed, `outputs.lossless_audio` and `outputs.subtitles`, each
 * a signed link or null. A status the Hub does not know is `unavailable`
 * (read again later), never guessed. The provider's error text, if any, is
 * not read.
 */
export function parseDubProgress(raw: Buffer): DubProgress {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AiVoiceProviderError('unavailable', 'not a dub');
  }
  const status = o?.status;
  if (typeof status !== 'string' || !DUB_STATUSES.includes(status as DubStatus))
    throw new AiVoiceProviderError('unavailable', 'not a dub');
  const outputs = (o.outputs ?? {}) as Record<string, unknown>;
  const link = (v: unknown): string | null => {
    const url =
      typeof v === 'string'
        ? v
        : typeof (v as { url?: unknown } | null)?.url === 'string'
          ? (v as { url: string }).url
          : null;
    return url !== null && url.length > 0 && url.length <= 4096 ? url : null;
  };
  return {
    status: status as DubStatus,
    audioUrl: link(outputs.lossless_audio),
    subtitlesUrl: link(outputs.subtitles),
  };
}

/**
 * Reads the answer to an asset upload (docs/elevenlabs/API-FACTS.md): `asset_id`. No id is no asset
 * (`unavailable`: the call may be tried again).
 */
export function parseUploadedAsset(raw: Buffer): UploadedAsset {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AiVoiceProviderError('unavailable', 'not an asset');
  }
  const id = o?.asset_id;
  if (typeof id !== 'string' || !PROVIDER_ID.test(id))
    throw new AiVoiceProviderError('unavailable', 'not an asset');
  return { assetId: id };
}

/** Reads the answer that starts a generation: `id` (and `status: pending`). No id is no generation. */
export function parseStartedGeneration(raw: Buffer): StartedGeneration {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AiVoiceProviderError('unavailable', 'not a generation');
  }
  const id = o?.id;
  if (typeof id !== 'string' || !PROVIDER_ID.test(id))
    throw new AiVoiceProviderError('unavailable', 'not a generation');
  return { id };
}

/**
 * Reads one read of a generation: `status` and, once `completed`, `content_url`
 * and `content_mime_type`; once `failed`, `failure_reason`. A status the Hub
 * does not know, or a `completed` with no link, is `unavailable` (read again
 * later), never guessed. The provider's error text is not read.
 */
export function parseGenerationProgress(raw: Buffer): GenerationProgress {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AiVoiceProviderError('unavailable', 'not a generation');
  }
  const status = o?.status;
  if (
    typeof status !== 'string' ||
    !GENERATION_STATUSES.includes(status as GenerationStatus)
  )
    throw new AiVoiceProviderError('unavailable', 'not a generation');
  const link = o.content_url;
  const mime = o.content_mime_type;
  const contentUrl =
    typeof link === 'string' && link.length > 0 && link.length <= 4096
      ? link
      : null;
  if (status === 'completed' && contentUrl === null)
    throw new AiVoiceProviderError('unavailable', 'no link');
  const reason = o.failure_reason;
  return {
    status: status as GenerationStatus,
    contentUrl: status === 'completed' ? contentUrl : null,
    contentType:
      status === 'completed' && typeof mime === 'string'
        ? mime.split(';')[0].trim().toLowerCase()
        : null,
    failure:
      status === 'failed'
        ? GENERATION_FAILURES.includes(reason as GenerationFailure)
          ? (reason as GenerationFailure)
          : 'unknown'
        : null,
  };
}
