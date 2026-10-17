/**
 * THE ONE SEAM TO THE AI VOICE PROVIDER (AITOOLS-01, R-68).
 *
 * Everything in `src/ai-tools/` reaches the provider only through
 * `AI_VOICE_PROVIDER`; nothing else imports the adapter (`http-voice-provider`).
 * The provider's key is the owner's and is set on the Hub (`AI_VOICE_API_KEY`);
 * until it is, `configured` is false, the tool is listed with `enabled: false`
 * and no job starts. Provider names stay out of every string a person sees:
 * the product calls this "AI voice tools".
 */
export const AI_VOICE_PROVIDER = Symbol('AI_VOICE_PROVIDER');

/** A voice a person can pick (what `GET /ai-tools` lists). The provider's own id never leaves the adapter. */
export interface AiVoice {
  /** WAWU's id for the voice. */
  id: string;
  name: string;
  description: string;
}

export interface SpeakRequest {
  /** A WAWU voice id from `voices()`. */
  voiceId: string;
  text: string;
}

export interface SpokenAudio {
  audio: Buffer;
  /** Always an audio type the Hub stores and serves (`audio/mpeg`). */
  contentType: 'audio/mpeg';
}

/**
 * Why the provider did not make the audio. `rejected`: it refused this text or
 * voice (trying again will not help). `unavailable`: it did not answer, or
 * answered with a fault (trying again may work). Either way the job fails and
 * every held point goes back.
 */
export class AiVoiceProviderError extends Error {
  constructor(
    readonly kind: 'rejected' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'AiVoiceProviderError';
  }
}

export interface AiVoiceProvider {
  /** True when a key, a host and at least one voice are set. */
  readonly configured: boolean;
  /** The voices on offer, in the order a person sees them. */
  voices(): readonly AiVoice[];
  /**
   * Makes the audio. A network call: the caller holds no transaction, no
   * connection and no lock while it runs. Throws `AiVoiceProviderError`.
   */
  speak(
    req: SpeakRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;
}
