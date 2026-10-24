import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiVoiceProviderError,
  type AiVoice,
  type AiVoiceProvider,
  type CopyPresence,
  type CopyRemoval,
  type MusicRequest,
  type IsolatedAudio,
  type IsolateRequest,
  type OwnVoiceRequest,
  type SoundEffectRequest,
  type SpeakRequest,
  type SpokenAudio,
  type StreamedFile,
  type Transcript,
  type TranscribeRequest,
  type TranscriptWord,
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
    const voice = this.catalogue.find((v) => v.id === req.voiceId);
    if (!this.configured || !voice || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'voice is not available');
    return this.synthesize(voice.providerVoiceId, req.text, opts.signal);
  }

  async speakQuick(
    req: SpeakRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    const voice = this.catalogue.find((v) => v.id === req.voiceId);
    if (!this.configured || !voice || this.baseUrl === null)
      throw new AiVoiceProviderError('rejected', 'voice is not available');
    return this.synthesize(
      voice.providerVoiceId,
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
    opts: { signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (!this.configured || this.baseUrl === null || this.apiKey === null)
      throw new AiVoiceProviderError('rejected', 'voice is not available');
    const voiceId = await this.addVoice(req.sample, opts.signal);
    try {
      return await this.synthesize(voiceId, req.text, opts.signal);
    } finally {
      await this.removeVoice(voiceId);
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
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="recording"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
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
