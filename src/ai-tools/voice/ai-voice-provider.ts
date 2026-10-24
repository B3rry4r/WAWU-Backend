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

/** A copy the provider keeps of what it made, to delete once the Hub has the result. `dub` is a Dubbing project (AITOOLS-05). */
export interface ProviderCopy {
  kind: 'transcript' | 'isolation' | 'dub';
  id: string;
}

/**
 * A recording or video to dub into one language (Dubbing, AITOOLS-05): the
 * person's own file, streamed to the provider for this one run, the language
 * to hear it in and, when the person said it, the language spoken in it.
 */
export interface StartDubRequest {
  file: VoiceSample | StreamedFile;
  /** BCP-47 tag from the list the Hub offers (`ai.dubbing_languages`). */
  targetLanguage: string;
  /** The language spoken in the file; null lets the provider detect it. */
  sourceLanguage: string | null;
}

/** The provider's ids for a dub it has started. */
export interface StartedDub {
  projectId: string;
  /** The language target the dub is followed on; null when the provider named none (the Hub then ends the job and deletes the project). */
  languageId: string | null;
}

/** Where a dub's language target stands (the provider's own words). */
export type DubStatus =
  'queued' | 'processing' | 'completed' | 'stale' | 'failed';

/**
 * One read of a dub's language target. The links are signed, last about an
 * hour and are for the Hub to fetch once (`fetchDubOutputs`); they never reach
 * a person.
 */
export interface DubProgress {
  status: DubStatus;
  audioUrl: string | null;
  subtitlesUrl: string | null;
}

/** What `fetchDubOutputs` brings back: the lossless audio (FLAC) and, when the provider made them, the WebVTT subtitles. */
export interface DubOutputs {
  audio: Buffer;
  contentType: 'audio/flac';
  subtitles: string | null;
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
   * Starts a dub (Dubbing, AITOOLS-05): `POST /v1/dubbing/project` with the
   * person's file streamed as the body, the target language and the source
   * language when given. Answers at once with the provider's project and
   * language ids; the dub itself takes minutes and is followed with `readDub`.
   * A network call: the caller holds no transaction, no connection and no
   * lock. Throws `AiVoiceProviderError`.
   */
  startDub(
    req: StartDubRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<StartedDub>;

  /**
   * One read of a dub's language target. Throws `AiVoiceProviderError` (the
   * provider's HTTP status rides on it, for the log only). The caller holds
   * no transaction, connection or lock.
   */
  readDub(
    projectId: string,
    languageId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DubProgress>;

  /**
   * Fetches a finished dub's signed links once: the audio (checked to be a
   * FLAC file, at most `maxAudioBytes`) and the subtitles (checked to be
   * WebVTT, dropped when they are not). The provider's key is never sent to a
   * link. Throws `AiVoiceProviderError`.
   */
  fetchDubOutputs(
    links: { audioUrl: string; subtitlesUrl: string | null },
    opts: { maxAudioBytes: number; signal?: AbortSignal },
  ): Promise<DubOutputs>;

  /** One try at deleting the provider's project of a dub. Never throws; same answers as `deleteTranscript`. */
  removeDub(projectId: string): Promise<CopyRemoval>;

  /** Reads the provider's project of a dub by id, only to learn whether it is there (status only). Never throws; same answers as `transcriptPresence`. */
  dubPresence(projectId: string): Promise<CopyPresence>;

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
