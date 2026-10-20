import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiVoiceProviderError,
  type AiVoice,
  type AiVoiceProvider,
  type SpeakRequest,
  type SpokenAudio,
} from './ai-voice-provider';

/** The settings of the adapter, all from the environment. */
export const AI_VOICE_ENV = {
  baseUrl: 'AI_VOICE_BASE_URL',
  apiKey: 'AI_VOICE_API_KEY',
  voices: 'AI_VOICE_VOICES',
  model: 'AI_VOICE_MODEL',
  timeoutMs: 'AI_VOICE_TIMEOUT_MS',
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;
/** The most audio one job may bring back: a request bound, not a product figure. */
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

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
 * The adapter that speaks to the provider over HTTPS: one request per job,
 * `POST {base}/v1/text-to-speech/{voice}` with the key in `xi-api-key`, the
 * text in a JSON body and the audio (`audio/mpeg`) in the answer.
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
  private readonly timeoutMs: number;
  private readonly catalogue: readonly CatalogueEntry[];

  constructor(config: ConfigService) {
    const base = (config.get<string>(AI_VOICE_ENV.baseUrl) ?? '').trim();
    this.baseUrl = /^https?:\/\/[^\s/]+/.test(base)
      ? base.replace(/\/+$/, '')
      : null;
    this.apiKey =
      (config.get<string>(AI_VOICE_ENV.apiKey) ?? '').trim() || null;
    this.model = (config.get<string>(AI_VOICE_ENV.model) ?? '').trim() || null;
    const t = Number(config.get<string>(AI_VOICE_ENV.timeoutMs));
    this.timeoutMs = Number.isFinite(t) && t >= 1000 ? t : DEFAULT_TIMEOUT_MS;
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
        `AI voice tools are off (${AI_VOICE_ENV.baseUrl}, ${AI_VOICE_ENV.apiKey} and ${AI_VOICE_ENV.voices} are all needed).`,
      );
    }
  }

  get configured(): boolean {
    return (
      this.baseUrl !== null && this.apiKey !== null && this.catalogue.length > 0
    );
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
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voice.providerVoiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'audio/mpeg',
            'xi-api-key': this.apiKey ?? '',
          },
          body: JSON.stringify({
            text: req.text,
            ...(this.model ? { model_id: this.model } : {}),
          }),
          signal,
        },
      );
    } catch {
      // A timeout, a refused connection or a broken one: the text is not in
      // this message, and neither is the provider's reply.
      throw new AiVoiceProviderError('unavailable', 'no answer');
    }
    if (!res.ok) {
      // Drain the reply without keeping it, so the connection is freed.
      await res.arrayBuffer().catch(() => undefined);
      const retryable = res.status === 429 || res.status >= 500;
      throw new AiVoiceProviderError(
        retryable ? 'unavailable' : 'rejected',
        `status ${res.status}`,
      );
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
}
