import type { Readable } from 'node:stream';
import type { AiAudioContentType } from '../audio/ai-audio-store';

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

/** A sound effect to make (AITOOLS-03): a description and, optionally, how long. */
export interface SoundEffectRequest {
  prompt: string;
  /** 0.5 to 30 seconds; null lets the provider choose. */
  durationSeconds: number | null;
}

/** A music track to make (AITOOLS-03): a description, optionally how long, and whether it is without singing. */
export interface MusicRequest {
  prompt: string;
  /** Whole seconds; null lets the provider choose. */
  lengthSeconds: number | null;
  instrumental: boolean;
}

/** One word of a transcript with its place in the recording, in seconds. */
export interface TranscriptWord {
  text: string;
  /** `word` for a spoken word; `spacing` and `audio_event` are not words. */
  type: string;
  start: number;
  end: number;
}

/** A recording or video to turn into words (Captions, AITOOLS-04). */
export interface TranscribeRequest {
  /** The person's own file, read by the provider for this one run (streamed from the store, or in memory). */
  file: VoiceSample | StreamedFile;
  /** ISO 639 code of the language spoken; null lets the provider detect it. */
  languageCode: string | null;
}

/** What the provider heard. */
export interface Transcript {
  text: string;
  words: TranscriptWord[];
  /** The length the provider measured, in seconds; null when it did not say. */
  durationSeconds: number | null;
  /** The provider's own id for the transcript, to delete its copy; null when it gave none. */
  id: string | null;
}

/**
 * How one try at deleting the provider's copy went: `deleted` (a 2xx), `not_found`
 * (404: the copy may not be stored yet, or is already gone) or `failed` (any other
 * answer, or none).
 */
export type CopyRemoval = 'deleted' | 'not_found' | 'failed';

/**
 * Whether the provider still holds a copy, from a read of it: `present` (a
 * 2xx), `absent` (404) or `unknown` (any other answer, or none).
 */
export type CopyPresence = 'present' | 'absent' | 'unknown';

/** A copy the provider keeps of what it made, to delete once the Hub has the result. */
export interface ProviderCopy {
  /** `voice` (AITOOLS-07): the AI version of a person's own voice the provider made for one VoiceOver. */
  kind: 'transcript' | 'isolation' | 'voice';
  id: string;
}

/** A recording or video to take the noise out of (Clean audio, AITOOLS-04). */
export interface IsolateRequest {
  file: VoiceSample | StreamedFile;
}

/** The cleaned recording, as the provider answered it. */
export interface IsolatedAudio {
  audio: Buffer;
  /** The type the provider answered, lower case, without parameters. The pipeline stores it only if the Hub serves it. */
  contentType: string;
  /** The provider's own id for the item it keeps (the `audio-isolation-id` header), to delete its copy; null when it gave none. */
  historyId: string | null;
}

export interface SpokenAudio {
  audio: Buffer;
  /** An audio type the Hub stores and serves (`audio/mpeg` for every tool but Clean audio, which stores what the provider answered if the Hub serves it). */
  contentType: AiAudioContentType;
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
    /** The provider's HTTP status, when it answered one (a key or plan refusal reads 401 or 402). Never shown to a person. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiVoiceProviderError';
  }
}

/**
 * A person's file on its way to the provider for one run (AITOOLS-04 round
 * 4): the bytes are sent on as the store gives them and the Hub never holds the
 * file whole (a few hundred KB at a time, however big the file is). The stream
 * carries exactly `bytes` bytes, the object's real length from the store.
 */
export interface StreamedFile {
  bytes: number;
  contentType: string;
  stream: Readable;
  /**
   * Called by the provider seam when the last byte has been written to the
   * provider, or the call was given up: it hands the Hub's place at the read
   * gate back (the provider thinking afterwards holds none of the file).
   * Safe to call more than once; also destroys the stream.
   */
  sent: () => void;
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
  /** True when a key and a host are set: Sound effect and Music track use no voice, so they do not need one. */
  readonly promptToolsConfigured: boolean;
  /** True when a key and a host are set: Captions and Clean audio take a file and need no voice either. */
  readonly fileToolsConfigured: boolean;
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
   * Makes a sound effect from a description (Sound effect, AITOOLS-03). One
   * request, the audio in the answer. A network call, with the same rules as
   * `speak`. Throws `AiVoiceProviderError`.
   */
  makeSoundEffect(
    req: SoundEffectRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /**
   * Makes a music track from a description (Music track, AITOOLS-03). One
   * request with no provider job id, which can run for a long time: it has its
   * own, longer timeout (`AI_VOICE_MUSIC_TIMEOUT_MS`). A network call, with
   * the same rules as `speak`. Throws `AiVoiceProviderError`.
   */
  makeMusic(
    req: MusicRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /**
   * Turns a recording or video into words (Captions, AITOOLS-04): one
   * request, the words with their times in the answer. The call honours the
   * configured file timeout (`AI_VOICE_FILE_TIMEOUT_MS`). A network call: the
   * caller holds no transaction, no connection and no lock. Throws
   * `AiVoiceProviderError`.
   */
  transcribe(
    req: TranscribeRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<Transcript>;

  /**
   * One try at deleting the provider's copy of a transcript, so it keeps no
   * copy of a person's words. Never throws; says how the try went (the caller
   * decides whether to try again). The provider answers 404 for a transcript
   * it has not stored yet, which is `not_found` here too.
   */
  deleteTranscript(id: string): Promise<CopyRemoval>;

  /**
   * Reads the provider's copy of a transcript by id, only to learn whether it
   * is there (the body is dropped unopened). Round 3: the provider answers 200 (or
   * 404) to a delete sent just after its answer and the transcript still
   * appears afterwards, so a delete's answer is not proof; a read that says
   * 404 after a delete is. Never throws.
   */
  transcriptPresence(id: string): Promise<CopyPresence>;

  /**
   * Takes the noise out of a recording or video (Clean audio, AITOOLS-04):
   * one request, the cleaned audio in the answer. Same rules as `transcribe`.
   * Throws `AiVoiceProviderError`.
   */
  isolateVoice(
    req: IsolateRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<IsolatedAudio>;

  /** One try at deleting the provider's history item of a cleaned recording. Never throws; same answers as `deleteTranscript`. */
  deleteIsolation(id: string): Promise<CopyRemoval>;

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
    opts?: {
      signal?: AbortSignal;
      /**
       * AITOOLS-07: called with the provider's id of the voice it made, right
       * after it was made. When it answers `true` the caller has noted the id
       * (so a server that dies still knows the voice is there) and owns its
       * removal (`deleteOwnVoice`, tried again until the provider has dropped
       * it): the adapter then leaves the voice in place. Anything else (false,
       * a throw, not given) and the adapter removes the voice itself, as VOICE-01 does.
       */
      handOver?: (providerVoiceId: string) => Promise<boolean>;
    },
  ): Promise<SpokenAudio>;

  /**
   * The WAWU ids of the listed voices the provider has a sample for
   * (AITOOLS-07, G-POINTS-08-1): one read of the provider's voice list, kept for
   * an hour. A read that fails answers what it has (nothing, the first time).
   * Never throws. The provider's own links never leave the adapter: the Hub
   * serves each sample itself (`sample`).
   */
  samples(): Promise<ReadonlySet<string>>;

  /**
   * A short sample of one listed voice, for the play button on its row; null
   * when the provider has none, or it cannot be read now. Kept for an hour. A
   * network call, never holds a transaction, connection or lock. Never throws.
   */
  sample(voiceId: string): Promise<SpokenAudio | null>;

  /**
   * One try at removing a voice made for a person's own voice (AITOOLS-07).
   * Never throws; same answers as `deleteTranscript`. `not_found` here means
   * the voice is already gone.
   */
  deleteOwnVoice(providerVoiceId: string): Promise<CopyRemoval>;
}
