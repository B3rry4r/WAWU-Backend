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
  /**
   * AITOOLS-11: the provider's own id of the person's SAVED clone ("Your voice"), read from the Hub's own row. When it
   * is given the adapter speaks with it and `voiceId` is not looked up in the catalogue.
   */
  providerVoiceId?: string;
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

/**
 * A copy the provider keeps of what it made, to delete once the Hub has the result. `dub` is a Dubbing project (AITOOLS-05).
 * `asset` (AITOOLS-09, AITOOLS-10) is the person's own photo or speech that the Hub sent up for one picture or video run:
 * `id` holds the provider's asset ids joined with `+` (a talking photo has two).
 */
export interface ProviderCopy {
  /** `voice` (AITOOLS-07): the AI version of a person's own voice the provider made for one VoiceOver. */
  kind:
    | 'transcript'
    | 'isolation'
    | 'voice'
    | 'dub'
    | 'asset'
    | 'podcast'
    /** REC-PRIVACY: a Receptionist conversation (a text chat or a finished talk) the provider keeps until it is deleted. */
    | 'conversation';
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
 * A person's photo or speech sent to the provider for ONE picture or video run
 * (AITOOLS-09, AITOOLS-10). The provider keeps it as an asset until the Hub
 * deletes it when the job ends.
 */
export interface AssetUpload {
  file: VoiceSample | StreamedFile;
  /** Only picks the plain file name the Hub sends (`photo.png`, `speech.mp3`); never the person's own name for the file. */
  kind: 'photo' | 'speech';
}

/** What the provider answered an asset upload with. */
export interface UploadedAsset {
  assetId: string;
}

/** A picture to make (AITOOLS-09). `assetIds` are the person's photos already uploaded for this run (Edit a photo). */
export interface StartImageRequest {
  /** The model the setting `ai.image_model` names. Never shown to a person (R-68). */
  model: string;
  prompt: string;
  /** The shape: an `aspect_ratio` of the model (`1:1`, `4:5`, `9:16`, `16:9`). */
  shape: string;
  /** `512`, `1K`, `2K` or `4K`. */
  resolution: string;
  assetIds: string[];
}

const upTo = (max: number) => Array.from({ length: max - 3 }, (_, i) => i + 4);

/**
 * The whole seconds each clip model makes (the provider's API reference, `duration_secs`). The wire takes a NUMBER:
 * the downloaded reference says a string for the Veo models, the live provider refused that (422, 30 Oct 2026), and
 * the live answer wins. `creatify-aurora` makes a talking photo and takes no length, so it is not here.
 */
export const VIDEO_MODEL_LENGTHS: Readonly<Record<string, readonly number[]>> =
  {
    'veo-3.1-fast-generate-001': [4, 6, 8],
    'veo-3.1-generate-001': [4, 6, 8],
    'bytedance-seedance-v2': upTo(15),
    'bytedance-seedance-v2-fast': upTo(15),
    'bytedance-seedance-v2-mini': upTo(15),
    'bytedance-seedance-v2.5': upTo(30),
  };

/** False when the provider's reference names the model and the length is not one it makes (a model it does not name is the Hub's own lengths alone). */
export const clipLengthFits = (model: string, seconds: number): boolean =>
  VIDEO_MODEL_LENGTHS[model]?.includes(seconds) ?? true;

/** A clip or a talking photo to make (AITOOLS-10). */
export type StartVideoRequest =
  | {
      kind: 'clip';
      model: string;
      prompt: string;
      shape: string;
      /** Whole seconds, one of `VIDEO_MODEL_LENGTHS[model]`. */
      seconds: number;
      resolution: string;
      withSound: boolean;
      /** The person's photo to start from, already uploaded; null for a clip from words alone. */
      startFrameAssetId: string | null;
    }
  | {
      kind: 'talking';
      model: string;
      resolution: string;
      imageAssetId: string;
      audioAssetId: string;
    };

/** The provider's id for a picture or video it has started. The generation is followed with `readImage` or `readVideo`. */
export interface StartedGeneration {
  id: string;
}

export type GenerationStatus =
  'pending' | 'generating' | 'completed' | 'failed';

/** Why the provider failed a generation, in the Hub's own words. `moderated` is the one a person is told differently. */
export type GenerationFailure =
  | 'moderated'
  | 'timeout'
  | 'model_error'
  | 'invalid_parameters'
  | 'dependency_failed'
  | 'charging_failed'
  | 'internal_error'
  | 'unknown';

/**
 * One read of a generation. The link is signed, lasts about an hour and is for
 * the Hub to fetch once (`openGeneration`); it never reaches a person.
 */
export interface GenerationProgress {
  status: GenerationStatus;
  contentUrl: string | null;
  /** The type the provider says the file is, lower case, without parameters. */
  contentType: string | null;
  failure: GenerationFailure | null;
}

/**
 * A finished generation's file on its way to storage: read as a stream, never
 * held whole. `bytes` is the length the provider declared (null when it did
 * not say); the stream is stopped at the cap given to `openGeneration`.
 * `close()` gives the connection back; safe to call twice.
 */
export interface StreamedMedia {
  contentType: string;
  bytes: number | null;
  stream: Readable;
  close: () => void;
}

// ---- Voice changer, Dialogue, a saved clone, Music for a video, Split a song (AITOOLS-11, AITOOLS-12, R-109) -------------

/** A recording turned into another voice (Voice changer): the same words and timing in the chosen voice. */
export interface ChangeVoiceRequest {
  /** The person's own recording, streamed to the provider for this one run. */
  file: VoiceSample | StreamedFile;
  /** A WAWU voice id from `voices()`; ignored when `providerVoiceId` is given. */
  voiceId: string;
  /** The provider's id of the person's saved clone, when the voice is "Your voice". */
  providerVoiceId?: string;
  /** The model the setting `ai.voice_changer_model` names (never shown to a person, R-68). */
  model: string;
}

/** One line of a scene: the words and who says them. */
export interface DialogueLine {
  text: string;
  /** A WAWU voice id from `voices()`; ignored when `providerVoiceId` is given. */
  voiceId: string;
  providerVoiceId?: string;
}

/** A scene for several voices (Dialogue). */
export interface DialogueRequest {
  lines: DialogueLine[];
  /** The model the setting `ai.dialogue_model` names. */
  model: string;
}

/** A recording to keep a clone of (Clone your own voice). */
export interface CloneVoiceRequest {
  /** The name the clone is kept under at the provider. Plain; never the person's own name for the file. */
  name: string;
  file: VoiceSample | StreamedFile;
}

/** The provider's id for the clone it made. Kept on the Hub's own row; it never reaches a person. */
export interface ClonedVoice {
  providerVoiceId: string;
}

/** A video to make music for (Music for a video). */
export interface MusicForVideoRequest {
  file: VoiceSample | StreamedFile;
  /** The mood in words, up to 1,000 characters; null when the person gave none. */
  description: string | null;
}

/** A song to split into its parts (Split a song). */
export interface SplitStemsRequest {
  file: VoiceSample | StreamedFile;
  /** Two parts (voice and the rest) or six. */
  parts: 2 | 6;
}

/** The provider's answer to a split: ONE ZIP archive, opened by the Hub (`readZip`), never by the adapter. */
export interface StemArchive {
  archive: Buffer;
}

// ---- Audiobook, Podcast maker, Receptionist (AITOOLS-13, AITOOLS-06, R-109) ------------------------------------------

/** One chapter of an Audiobook on the speech route: the text, and what came before and after it so the voice carries over the join. */
export interface SpeakChapterRequest {
  /** A WAWU voice id from `voices()`. */
  voiceId: string;
  text: string;
  /** The model the setting `ai.audiobook_model` names (never shown to a person, R-68). */
  model: string;
  previousText: string | null;
  nextText: string | null;
}

/** A podcast to make (Studio API, allowlisted accounts only): one host reading it, or two voices talking. */
export interface StartPodcastRequest {
  /** The model the setting `ai.podcast_model` names. */
  model: string;
  mode: 'conversation' | 'bulletin';
  /** WAWU voice ids from `voices()`. `guestVoiceId` is set for a conversation only. */
  hostVoiceId: string;
  guestVoiceId: string | null;
  source: { type: 'text'; text: string } | { type: 'url'; url: string };
  /** `short` (under 3 minutes), `default` (about 3 to 7) or `long` (over 7). */
  duration: 'short' | 'default' | 'long';
  /** Two letters, from `ai.podcast_languages`. */
  language: string;
}

/** The provider's id for the podcast project it has started (its copy, deleted when the job ends). */
export interface StartedPodcast {
  projectId: string;
}

/** One read of a podcast project. */
export interface PodcastProgress {
  /** True once the provider can give the audio. */
  ready: boolean;
}

/**
 * REC-PRIVACY: what every Receptionist agent is told about keeping conversations (`platform_settings.privacy`). The
 * provider keeps an agent's conversations for ever by default (`retention_days` -1, `record_voice` true), so the Hub
 * sets these on every create and every update and keeps nothing longer than it must.
 *
 * `retention_days` is 1: the provider's API file (PrivacyConfig-Input) types it as an integer with no stated minimum
 * and says only that -1 means "no retention limit", so 1 is the smallest whole number of days it documents; 0 and other
 * negatives are not described and are not used. `zero_retention_mode` is NOT set: the API file describes it with no
 * plan note for agents, and the same file says zero retention may only be used by enterprise customers.
 * Not yet proven against the real provider (no credits): see tasks/AITOOLS-06.md, Current state.
 */
export const AGENT_PRIVACY = {
  record_voice: false,
  retention_days: 1,
  delete_audio: true,
  delete_transcript_and_pii: true,
} as const;

/** What a Receptionist is at the provider: its words, language, model, voice and the documents it knows. */
export interface AgentSpec {
  name: string;
  /** The Hub's instructions for the agent, ending in its own guardrail text. */
  prompt: string;
  firstMessage: string;
  /** A two letter code from `ai.receptionist_languages`. */
  language: string;
  /** The model the setting `ai.receptionist_llm` names (never shown to a person). */
  llm: string;
  /** A WAWU voice id from `voices()`. */
  voiceId: string;
  /** The documents it knows, by the provider's id. */
  knowledge: { id: string; name: string; kind: 'text' | 'url' | 'file' }[];
}

/** One earlier message of a Receptionist chat, sent again so the next reply has context. */
export interface ChatTurn {
  role: 'person' | 'agent';
  text: string;
}

/** A talking session the app opens straight with the provider on a signed link (the Hub carries no audio). */
export interface VoiceSessionLink {
  signedUrl: string;
  conversationId: string;
}

/** A finished conversation as the provider reports it. */
export interface ConversationRead {
  /** `done` when the provider has closed it and knows its length. */
  status: 'initiated' | 'in-progress' | 'processing' | 'done' | 'failed';
  /** The length in whole seconds, when the provider says it. */
  seconds: number | null;
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

  // ---- Studio pictures and video (AITOOLS-09, AITOOLS-10, R-109) -----------

  /** True when a key and a host are set: Make an image, Edit a photo, Make a video and Talking photo need no voice. */
  readonly mediaToolsConfigured: boolean;

  /**
   * Sends a person's photo or speech up as an asset (`POST /v1/assets`) for one
   * run. The file streams from the store behind the read gate and is never held
   * whole. A network call: the caller holds no transaction, no connection and
   * no lock. Throws `AiVoiceProviderError`.
   */
  uploadAsset(
    req: AssetUpload,
    opts?: { signal?: AbortSignal },
  ): Promise<UploadedAsset>;

  /** One try at deleting an asset the Hub sent up. Never throws; same answers as `deleteTranscript` (`not_found` means it is already gone). */
  removeAsset(assetId: string): Promise<CopyRemoval>;

  /** Starts a picture (`POST /v1/flows/image`). Answers at once with the generation's id. Throws `AiVoiceProviderError`. */
  startImage(
    req: StartImageRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<StartedGeneration>;

  /** One read of a picture (`GET /v1/flows/image/{id}`). Throws `AiVoiceProviderError` (the status rides on it, for the log only). */
  readImage(
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<GenerationProgress>;

  /** Starts a clip or a talking photo (`POST /v1/flows/video`). Answers at once with the generation's id. Throws `AiVoiceProviderError`. */
  startVideo(
    req: StartVideoRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<StartedGeneration>;

  /** One read of a video (`GET /v1/flows/video/{id}`). Throws `AiVoiceProviderError`. */
  readVideo(
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<GenerationProgress>;

  /**
   * Opens a finished generation's signed link to be read as a stream, once. The
   * link is the provider's to name, so it is checked first (https to a name, or
   * http to the very host the Hub is set up with, the local stand-in), and the
   * provider's key is never sent to it. The answer's type must be one of
   * `types` and the stream is stopped at `maxBytes`. Throws
   * `AiVoiceProviderError`.
   */
  openGeneration(
    link: string,
    opts: {
      maxBytes: number;
      types: readonly string[];
      signal?: AbortSignal;
    },
  ): Promise<StreamedMedia>;

  // ---- Voice changer, Dialogue, a saved clone, Music for a video, Split a song (AITOOLS-11, AITOOLS-12, R-109) -----
  // NOT RUN against the real provider (the owner's credits are not bought yet); every path is run against the
  // stand-in (`scripts/dev/voice-standin.cjs`) with the wire shape of the provider's file.

  /**
   * Turns a recording into another voice (`POST /v1/speech-to-speech/{voice_id}`, multipart `audio`, `model_id`,
   * `remove_background_noise` off). Synchronous: the audio (mp3) is the answer. The file streams from the store behind
   * the read gate. A network call: the caller holds no transaction, connection or lock. Throws `AiVoiceProviderError`.
   */
  changeVoice(
    req: ChangeVoiceRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /**
   * Makes a scene for several voices (`POST /v1/text-to-dialogue`, `inputs`, `model_id`). Synchronous: mp3. The Hub
   * has already held the scene to at most 10 voices and its character limit. Throws `AiVoiceProviderError`.
   */
  makeDialogue(
    req: DialogueRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /**
   * Keeps a clone of a person's voice (`POST /v1/voices/add`, multipart `name` and `files`). Answers the provider's id
   * for it. The caller has the person's agreement and has written its reservation. Throws `AiVoiceProviderError`.
   */
  cloneVoice(
    req: CloneVoiceRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<ClonedVoice>;

  /**
   * Makes music for a video (`POST /v1/music/video-to-music`, multipart `videos`, optional `description`). A long
   * synchronous call, like Music track (its own long timeout). Answers music only (mp3): the provider returns no video.
   * A 403 `Subscription required` rides on the error's `status`. Throws `AiVoiceProviderError`.
   */
  makeMusicForVideo(
    req: MusicForVideoRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /**
   * Splits a song into its parts (`POST /v1/music/stem-separation`, multipart `file`, `stem_variation_id`). A long
   * synchronous call; the answer is a ZIP, handed back unopened. Throws `AiVoiceProviderError`.
   */
  splitStems(
    req: SplitStemsRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<StemArchive>;

  // ---- Audiobook, Podcast maker (AITOOLS-13, R-109) --------------------------------------------------------------
  // NOT RUN against the real provider (the owner's credits are not bought yet); every path is run against the
  // stand-in (`scripts/dev/voice-standin.cjs`) with the wire shape of the provider's file.

  /**
   * One chapter of an Audiobook (`POST /v1/text-to-speech/{voice_id}` with `previous_text` and `next_text`, mp3). The
   * same route VoiceOver uses; synchronous. Throws `AiVoiceProviderError`.
   */
  speakChapter(
    req: SpeakChapterRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /** True when a key and a host are set: the Studio API (Podcast maker) needs a voice list too only for the voices it names. */
  readonly podcastConfigured: boolean;

  /** Starts a podcast (`POST /v1/studio/podcasts`). Answers at once with the project's id. A 403 means the account is not allowlisted. Throws `AiVoiceProviderError`. */
  startPodcast(
    req: StartPodcastRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<StartedPodcast>;

  /** One read of a podcast project (`GET /v1/studio/projects/{id}`). Throws `AiVoiceProviderError` (the status rides on it, for the log only). */
  readPodcast(
    projectId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<PodcastProgress>;

  /**
   * The finished podcast's audio: lists the project's snapshots (`GET .../snapshots`), takes the newest and streams it
   * (`POST .../snapshots/{id}/stream`, mp3). Throws `AiVoiceProviderError`.
   */
  fetchPodcastAudio(
    projectId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SpokenAudio>;

  /** One try at deleting the provider's project (`DELETE /v1/studio/projects/{id}`). Never throws; same answers as `deleteTranscript`. */
  removePodcast(projectId: string): Promise<CopyRemoval>;

  // ---- Receptionist (AITOOLS-06, R-109) ---------------------------------------------------------------------------
  // The talking agent in the app. No phone, WhatsApp, call or call list is reached through this seam (R-109 point 3).

  /** True when a key and a host are set. */
  readonly agentsConfigured: boolean;

  /** Makes an agent (`POST /v1/convai/agents/create`). Answers its id. Throws `AiVoiceProviderError`. */
  createAgent(
    spec: AgentSpec,
    opts?: { signal?: AbortSignal },
  ): Promise<{ agentId: string }>;

  /** Edits an agent (`PATCH /v1/convai/agents/{id}`). Throws `AiVoiceProviderError`. */
  updateAgent(
    agentId: string,
    spec: AgentSpec,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;

  /** One try at deleting an agent (`DELETE /v1/convai/agents/{id}`). Never throws; same answers as `deleteTranscript`. */
  deleteAgent(agentId: string): Promise<CopyRemoval>;

  /** Adds a typed text (`POST /v1/convai/knowledge-base/text`). Answers the document's id. Throws `AiVoiceProviderError`. */
  addKnowledgeText(
    req: { name: string; text: string },
    opts?: { signal?: AbortSignal },
  ): Promise<{ id: string }>;

  /** Adds a web page (`POST /v1/convai/knowledge-base/url`). Answers the document's id. Throws `AiVoiceProviderError`. */
  addKnowledgeUrl(
    req: { name: string; url: string },
    opts?: { signal?: AbortSignal },
  ): Promise<{ id: string }>;

  /** Adds a document (`POST /v1/convai/knowledge-base/file`, multipart). Answers the document's id. Throws `AiVoiceProviderError`. */
  addKnowledgeFile(
    req: { name: string; file: VoiceSample | StreamedFile },
    opts?: { signal?: AbortSignal },
  ): Promise<{ id: string }>;

  /** One try at deleting a knowledge document (`DELETE /v1/convai/knowledge-base/{id}?force=true`, so it also leaves the agent). Never throws. */
  deleteKnowledge(id: string): Promise<CopyRemoval>;

  /**
   * One text message to an agent, over the agent socket with the text-only setting (no audio is made or priced):
   * `earlier` is sent again as context, the reply is the agent's first answer. A network call; holds no transaction,
   * connection or lock. Throws `AiVoiceProviderError`.
   *
   * REC-PRIVACY: the chat is a conversation the provider keeps, so its id is asked for with the link and answered
   * (`conversationId`, empty when the provider named none). `onConversation` is told the id the moment it is known,
   * before the socket opens, so the caller can note it even when the answer never comes; it must not throw.
   */
  askAgent(
    req: { agentId: string; message: string; earlier: readonly ChatTurn[] },
    opts?: {
      signal?: AbortSignal;
      onConversation?: (conversationId: string) => void | Promise<void>;
    },
  ): Promise<{ reply: string; conversationId: string }>;

  /** A signed link for a talking session (`GET /v1/convai/conversation/get-signed-url`, with the conversation id). Throws `AiVoiceProviderError`. */
  openVoiceSession(
    agentId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<VoiceSessionLink>;

  /** Reads a conversation (`GET /v1/convai/conversations/{id}`): whether it is over and how long it lasted. Throws `AiVoiceProviderError` (`status` 404 when the provider has none by that id, which for a conversation made a moment ago may only mean "not stored yet"). */
  readConversation(
    conversationId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ConversationRead>;

  /**
   * One try at deleting a conversation the provider kept (`DELETE /v1/convai/conversations/{id}`), so it holds none of the
   * person's words. Never throws. REC-DELETE: the real provider answers 204 to a delete sent before the conversation is
   * `done` and ignores it, so a `deleted` answer proves nothing: the caller sends it only to a conversation a read shows
   * finished and clears its note only when a read after it says 404 (`ProviderCopyService`).
   */
  deleteConversation(conversationId: string): Promise<CopyRemoval>;
}
