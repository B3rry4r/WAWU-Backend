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

/** Someone's own recording, kept by the Hub as theirs; the provider only reads it for one run. */
export interface VoiceSample {
  audio: Buffer;
  /** The type the file was stored as (`audio/mp4`, `audio/mpeg`, `audio/wav`, `audio/aac`). */
  contentType: string;
}

export interface OwnVoiceRequest {
  /** The person's own 30 second recording (VOICE-01). */
  sample: VoiceSample;
  text: string;
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

  /**
   * Makes the audio on the provider's faster model (Quick voice,
   * AITOOLS-02): the same voices as `speak`, the model set by
   * `AI_VOICE_QUICK_MODEL`. A network call, with the same rules as `speak`.
   * Throws `AiVoiceProviderError`.
   */
  speakQuick(
    req: SpeakRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /**
   * Says a name in the studio voice (VF3, VOICE-01): the first voice the Hub
   * lists. Free to the person, so the caller limits how often it runs. A
   * network call, with the same rules as `speak`.
   */
  previewName(
    req: { text: string },
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;
  /**
   * Says the text in the voice of the person who made `sample` (VF8 to VF11,
   * VOICE-01, R-66). The adapter makes the voice for this one run and takes it
   * out again, so the provider keeps no standing copy of anyone's voice. The
   * caller has checked the person's consent and that the sample is theirs. A
   * network call: the caller holds no transaction, no connection and no lock
   * while it runs. Throws `AiVoiceProviderError`.
   */
  speakInOwnVoice(
    req: OwnVoiceRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;
}
