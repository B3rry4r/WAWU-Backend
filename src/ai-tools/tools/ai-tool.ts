import type { Readable } from 'node:stream';
import type { AiToolJob } from '../../../generated/prisma/client';
import type { PlansConfig } from '../../plans/plans-config';
import type {
  AiVoiceProvider,
  ChatTurn,
  ProviderCopy,
  SpokenAudio,
  StreamedFile,
  VoiceSample,
} from '../voice/ai-voice-provider';
import type { AiAudioFolder } from '../audio/ai-audio-store';
import type { AiMediaFolder } from '../media/ai-media-store';

/**
 * ONE TOOL OF THE JOB PIPELINE (AITOOLS-02, R-78).
 *
 * Every tool Studio lists is one file under `src/ai-tools/tools/`, registered
 * in `index.ts`. The pipeline (`AiJobService.createJob`) does the rest the same
 * way for each: price the request into units, hold the points through
 * POINTS-03, record the job, call the provider after the answer with nothing
 * held, store what came back, COMMIT, mark done; any failure RELEASES. A tool
 * file says only what differs: its ids, how a request is priced, what the
 * request carries, the one provider call, and what the job returns.
 */

/** The tool's id in the routes (`POST /ai-tools/{id}/jobs`) and in a job's `tool`. */
export type AiToolId =
  | 'voiceover'
  | 'quick-voice'
  | 'sound-effect'
  | 'music'
  | 'captions'
  | 'clean-audio'
  | 'dubbing'
  // R-109 (AITOOLS-09, AITOOLS-10): the Studio picture and video tools.
  | 'image'
  | 'photo-edit'
  | 'video'
  | 'talking-photo'
  // R-109 (AITOOLS-11, AITOOLS-12): Voice changer, Dialogue, a saved clone of your own voice, Music for a video, Split a song.
  | 'voice-changer'
  | 'dialogue'
  | 'my-voice'
  | 'video-music'
  | 'stems'
  // R-109 (AITOOLS-13, AITOOLS-06): Audiobook, Podcast maker and the Receptionist.
  | 'audiobook'
  | 'podcast'
  | 'receptionist';

/**
 * What a job takes in. `text` (words to speak), `prompt` (a description) and `file` (a recording or video the person
 * uploaded, AITOOLS-04). R-109 (AITOOLS-08) adds the room for the Studio tools: `image` (a description, and a photo for
 * Edit a photo), `video` (a description or a photo, or a photo and a voice for a Talking photo), and `dialogue` and `chat`,
 * which later tasks build. Only the kinds a built tool uses are listed in `GET /ai-tools`.
 */
export type AiToolInputKind =
  | 'text'
  | 'prompt'
  | 'file'
  | 'image'
  | 'video'
  | 'dialogue'
  | 'chat'
  | 'podcast';

/** How a text request reads once the pipeline has checked it. */
export interface TextJobRequest {
  kind: 'text';
  text: string;
  voiceId: string;
  /** AITOOLS-13 Audiobook: the key of a text file the person sent to `ai/input-doc` instead of typing the words (the Hub reads it into `text`). */
  fileKey?: string | null;
  /** AITOOLS-13 Audiobook: the speech model and the chapter size the settings named when the request was checked (set by the tool's `precheck`). */
  model?: string;
  chunkChars?: number;
}

/**
 * How a Podcast request reads (AITOOLS-13): a text or a link, one host or two, a length and a language. `characters`
 * is the text's length (0 for a link, which the provider reads). The model is the setting's, set by `precheck`.
 */
export interface PodcastJobRequest {
  kind: 'podcast';
  source: { type: 'text'; text: string } | { type: 'url'; url: string };
  mode: 'conversation' | 'bulletin';
  hostVoiceId: string;
  guestVoiceId: string | null;
  duration: 'short' | 'standard' | 'long';
  language: string;
  characters: number;
  model: string;
}

/** How a Receptionist message reads (AITOOLS-06): the person's words. The agent and the earlier turns are the Hub's, found when the job runs. */
export interface ChatJobRequest {
  kind: 'chat';
  message: string;
  characters: number;
}

/**
 * How a prompt request reads (AITOOLS-03): a description in words, and the
 * options the tool offers. `seconds` is the length the person asked for (null:
 * the provider chooses); `instrumental` is null when the tool has no such option.
 */
export interface PromptJobRequest {
  kind: 'prompt';
  prompt: string;
  seconds: number | null;
  instrumental: boolean | null;
}

/**
 * How a file request reads once the Hub has opened the file (AITOOLS-04): the
 * person's own file in an AI input folder, its length read by the Hub from
 * the file itself (never from anything the phone sent), and the minutes the
 * job is priced in.
 */
export interface FileJobRequest {
  kind: 'file';
  /** The storage key of the file, as `POST /uploads/presign` gave it. */
  fileKey: string;
  /** Captions: the language spoken (ISO 639), or null to let the provider detect it. */
  languageCode: string | null;
  /** Dubbing (AITOOLS-05): the language to hear the file in (a tag from `ai.dubbing_languages`). */
  targetLanguage?: string | null;
  /** Dubbing: the language spoken in the file, or null to let the provider detect it. */
  sourceLanguage?: string | null;
  /** The length the Hub read, in seconds. */
  seconds: number;
  /** Minutes the job is priced in: rounded up, at least 1. */
  minutes: number;
  bytes: number;
  contentType: string;
  /** AITOOLS-11 Voice changer: the voice to hear it in (a WAWU voice id, or `own` for the person's saved clone). */
  voiceId?: string | null;
  /** AITOOLS-11 and -12: the model the settings name, set by the tool's `precheck` (never shown to a person). */
  model?: string;
  /** AITOOLS-12 Music for a video: the mood in words (the provider takes up to 1,000 characters); null when none. */
  description?: string | null;
  /** AITOOLS-12 Split a song: two parts (voice and the rest) or six. */
  parts?: 2 | 6 | null;
  /** AITOOLS-11 Clone your own voice: the name the person gave it, and the words they agreed to (exactly the line the Hub served). */
  cloneName?: string | null;
  consentLine?: string | null;
}

/**
 * How a Dialogue request reads (AITOOLS-11): the lines of a scene, each with the voice that says it, and the model the
 * setting named when the request was checked. `characters` is the total of all the lines: it prices the job.
 */
export interface DialogueJobRequest {
  kind: 'dialogue';
  lines: { text: string; voiceId: string }[];
  characters: number;
  model: string;
}

/**
 * How a Studio picture or video request reads (AITOOLS-09, AITOOLS-10): the words, the shape and length asked, the
 * person's photo and speech by key, and the model and size the settings named when the request was checked. `photo`
 * and `speech` are set once the Hub has opened the person's files (their real type, size and, for speech, length).
 */
export interface MediaJobRequest {
  kind: 'media';
  /** The description; empty for a Talking photo, which has none. */
  prompt: string;
  /** The aspect ratio asked (`1:1`, `16:9`), or null to take the default. */
  shape: string | null;
  /** A clip's whole seconds (4, 6 or 8), or a Talking photo's speech length rounded up; null for a picture. */
  seconds: number | null;
  /** The person's photo in `ai/input-image` (Edit a photo, a clip's first frame, Talking photo). */
  photoKey: string | null;
  /** Talking photo: a recording the person sent to `ai/input-audio`. */
  audioKey: string | null;
  /** Talking photo: a finished voice job of the person's whose audio is the speech. */
  sourceJobId: string | null;
  /** The model, size and sound the settings named (set by the tool's `precheck`). */
  model: string;
  resolution: string;
  withSound: boolean;
  photo: { bytes: number; contentType: string } | null;
  speech: {
    source: 'upload' | 'job';
    /** The key to read it from: an input file, or a stored result of a job. */
    key: string;
    seconds: number;
    bytes: number;
    contentType: string;
  } | null;
}

export type AiToolRequest =
  | PodcastJobRequest
  | ChatJobRequest
  | TextJobRequest
  | PromptJobRequest
  | FileJobRequest
  | MediaJobRequest
  | DialogueJobRequest;

/** The request of a podcast tool; a tool is only ever handed the kind it declares. */
export function asPodcast(req: AiToolRequest): PodcastJobRequest {
  if (req.kind !== 'podcast')
    throw new Error('a podcast tool was given another kind');
  return req;
}

/** The request of a chat tool; a tool is only ever handed the kind it declares. */
export function asChat(req: AiToolRequest): ChatJobRequest {
  if (req.kind !== 'chat')
    throw new Error('a chat tool was given another kind');
  return req;
}

/** The request of a dialogue tool; a tool is only ever handed the kind it declares. */
export function asDialogue(req: AiToolRequest): DialogueJobRequest {
  if (req.kind !== 'dialogue')
    throw new Error('a dialogue tool was given another kind');
  return req;
}

/** The request of a media tool; a tool is only ever handed the kind it declares. */
export function asMedia(req: AiToolRequest): MediaJobRequest {
  if (req.kind !== 'media')
    throw new Error('a media tool was given another kind');
  return req;
}

/** The request of a file tool; a tool is only ever handed the kind it declares. */
export function asFile(req: AiToolRequest): FileJobRequest {
  if (req.kind !== 'file')
    throw new Error('a file tool was given another kind');
  return req;
}

/** The request of a text tool; a tool is only ever handed the kind it declares. */
export function asText(req: AiToolRequest): TextJobRequest {
  if (req.kind !== 'text') throw new Error('a text tool was given a prompt');
  return req;
}

/** The request of a prompt tool; a tool is only ever handed the kind it declares. */
export function asPrompt(req: AiToolRequest): PromptJobRequest {
  if (req.kind !== 'prompt') throw new Error('a prompt tool was given text');
  return req;
}

/** What one run of the provider gave back, before it is stored. */
export interface AiToolRunResult {
  /** Audio to keep under the job's key; stored and served as `outputs[].kind: audio` (and `audioUrl`). */
  audio?: SpokenAudio;
  /**
   * Several audio files, one per part (Split a song, AITOOLS-12), each with its plain name. Stored under keys of their
   * own and listed in `outputs` in this order. `slug` is letters, digits and `-`, unique within the result.
   */
  audios?: { label: string; slug: string; audio: SpokenAudio }[];
  /**
   * A clone the provider made for the person (AITOOLS-11): the pipeline writes it to the person's reservation before the
   * hold is committed, and gives it back (provider copy and row) when the job does not keep its points.
   */
  clone?: { providerVoiceId: string };
  /** Text outputs kept in the job row itself (`outputs[].text`). */
  texts?: { kind: 'text' | 'subtitles'; text: string }[];
  /**
   * A Studio result to keep (AITOOLS-09, AITOOLS-10): the picture or video, as a stream from the provider. The pipeline
   * stores it under the tool's `mediaFolder` without holding it whole, serves it as `outputs[].kind: image | video`, and
   * closes the stream however the job ends. A type the Hub does not serve fails the job and every point goes back.
   */
  media?: {
    kind: 'image' | 'video' | 'audio';
    contentType: string;
    bytes: number | null;
    stream: Readable;
    close: () => void;
  };
  /** AITOOLS-06: the Receptionist's reply, kept in the job row as its text; the pipeline then remembers the turn. */
  chatTurn?: { person: string; agent: string };
  /** The provider's own id for a long job, kept for a later look-up (`providerRef`). */
  providerRef?: string;
  /**
   * Set when the provider answered but the answer cannot be kept (its length
   * is more than a minute above the priced one, or the audio is a type the Hub
   * does not serve): the job fails with this code and every point goes back.
   */
  failure?: string;
  /**
   * The provider's copy of what it made (a transcript, a cleaned recording's
   * history item). The pipeline deletes it once the result is stored or
   * refused, however the job ends, so the provider keeps no copy of a person's
   * words or voice (`ProviderCopyService`: tries again and then keeps trying
   * until the provider has it stored and it is gone).
   */
  providerCopy?: ProviderCopy;
  /**
   * Set by a tool that FOLLOWS the provider (Dubbing, AITOOLS-05): the
   * provider took the work on and the job stays `working`. `ref` is what the
   * job row keeps (`providerRef`) so the follower can read the work again, also
   * after a restart. Nothing is stored, committed or released yet.
   */
  follow?: { ref: string };
  /**
   * A followed job's provider copy (its project), written onto the row in the
   * same update that ends the job, and deleted once the job has ended.
   */
  endCopy?: ProviderCopy;
}

/** What the pipeline hands a file tool's run: the person's file, streamed to the provider for this one run. */
export interface AiToolRunInput {
  file: VoiceSample | StreamedFile;
  /**
   * A Studio tool's own files (AITOOLS-09, AITOOLS-10): the person's photo and, for a Talking photo, the speech. Each is
   * OPENED when the tool asks for it, one after the other: the read gate gives an account one place at a time, so the
   * photo is sent up (which hands its place back) before the speech is opened. Each is streamed to the provider as an
   * asset for this one run; the pipeline hands every place back when the call ends. `file` holds `NO_FILE` for these
   * jobs: the files are here.
   */
  media?: {
    photo?: () => Promise<StreamedFile>;
    speech?: () => Promise<StreamedFile>;
  };
  /**
   * VoiceOver in the person's own voice (AITOOLS-07): notes the provider's copy
   * of the voice on the job as soon as it exists (answers `true` when it did),
   * so the pipeline removes it however the job ends. Absent for every other run.
   */
  noteCopy?: (copy: ProviderCopy) => Promise<boolean>;
  /**
   * AITOOLS-11: the provider's id of the person's SAVED clone, read from their own row, when the job names the voice
   * `own` and a clone is kept. The tool speaks (or changes the voice, or says the lines) with it; the saved clone wins
   * over a Voice Intro clone for one run. Absent otherwise.
   */
  savedVoice?: string;
  /** AITOOLS-06: the person's Receptionist at the provider and the earlier turns, read from the Hub's own rows when the job runs. */
  chat?: { agentId: string; earlier: ChatTurn[] };
}

/** What `AiToolRunInput.file` holds for a Studio job, whose files are opened one at a time through `media`. */
export const NO_FILE: VoiceSample = {
  audio: Buffer.alloc(0),
  contentType: 'application/octet-stream',
};

/** What a unit of a tool's price is: a minute of speech, one use, one track, or (R-109) a second of video. */
export type AiToolUnit = 'minute' | 'use' | 'track' | 'second' | 'message';

/** A tool that takes words to speak: priced in minutes of speech, in one of the listed voices. */
export interface TextInputSpec {
  kind: 'text';
  /** The setting for the characters that make one unit. */
  charactersPerUnitSetting: string;
  /**
   * AITOOLS-13 Audiobook: the setting for the longest text one job takes. Present, it replaces the plan's per-job
   * character cap for this tool (the tool checks its own limit), and the text may come as a file (`fileKey`).
   */
  maxCharactersSetting?: string;
}

/** A tool that takes a text or a link and makes a podcast of it (AITOOLS-13). */
export interface PodcastInputSpec {
  kind: 'podcast';
  /** The setting for the longest text one podcast is made from. */
  maxCharactersSetting: string;
  /** The setting that lists the languages on offer. */
  languagesSetting: string;
}

/** A tool that is a conversation with the person's own agent (AITOOLS-06): priced a message. */
export interface ChatInputSpec {
  kind: 'chat';
  /** The setting for the longest message. */
  maxCharactersSetting: string;
}

/** A tool that takes a description (AITOOLS-03): priced flat, with an optional length. */
export interface PromptInputSpec {
  kind: 'prompt';
  /** The setting for the longest description, in characters. */
  maxCharactersSetting: string;
  /** The optional length: the field the request names it by, the shortest the provider makes, the setting for the longest. */
  length: {
    field: 'durationSeconds' | 'lengthSeconds';
    minSeconds: number;
    maxSecondsSetting: string;
    whole: boolean;
  };
  /** True when the request may ask for no singing (`instrumental`). */
  instrumental: boolean;
}

/** A tool that takes the person's own recording or video (AITOOLS-04): priced by the minute of the file the Hub measures. */
export interface FileInputSpec {
  kind: 'file';
  /** True when the request may name the language spoken (`languageCode`). */
  languageCode: boolean;
  /** True for Dubbing (AITOOLS-05): the request names `targetLanguage` (from the settings' list) and may name `sourceLanguage`. */
  dubbing?: boolean;
  /** AITOOLS-11 and -12: the one kind of file the tool takes, when it is not both. Anything else is refused with nothing held. */
  only?: 'audio' | 'video';
  /** AITOOLS-11 Voice changer: the request names a `voiceId` (a Hub voice, or `own` for the saved clone). */
  voice?: boolean;
  /** AITOOLS-11 Clone your own voice: the request names a `name` and the person's agreement (`consentLine`). */
  clone?: boolean;
  /** AITOOLS-12 Music for a video: the request may carry a mood in words; the setting for its longest length. */
  description?: { maxCharactersSetting: string };
  /** AITOOLS-12 Split a song: the number of parts to pick from. */
  parts?: readonly (2 | 6)[];
  /** The setting for the longest recording or video, in seconds, when the tool bounds it (otherwise only the plan's minutes apply). */
  maxSecondsSetting?: string;
}

/** A tool that takes the lines of a scene (AITOOLS-11 Dialogue): priced on characters, one voice for each line. */
export interface DialogueInputSpec {
  kind: 'dialogue';
  /** The setting for the longest scene, in characters in all. */
  maxCharactersSetting: string;
  /** The setting for the characters that make one unit (a minute). */
  charactersPerUnitSetting: string;
  /** The most different voices one scene has (the provider's own limit). */
  maxVoices: number;
}

/**
 * A Studio picture or video tool (AITOOLS-09, AITOOLS-10): a description and what goes with it. The shapes, lengths and
 * photo rule ride to the app in `GET /ai-tools` (`input.options`).
 */
export interface MediaInputSpec {
  kind: 'image' | 'video';
  /** The setting for the longest description, in characters; absent for a Talking photo, which has no description. */
  maxCharactersSetting: string | null;
  /** The shapes the model takes, in the order the app draws them. */
  shapes: readonly string[];
  /** A video's lengths in seconds; absent for a picture. */
  lengths?: readonly number[];
  /** Whether a photo goes with the job. */
  photo: 'none' | 'optional' | 'required';
  /** Talking photo: the person's speech (a recording or a finished voice result); the setting for its longest length. */
  speech?: { maxSecondsSetting: string };
}

export type AiToolInputSpec =
  | PodcastInputSpec
  | ChatInputSpec
  | TextInputSpec
  | PromptInputSpec
  | FileInputSpec
  | MediaInputSpec
  | DialogueInputSpec;

/** Whether the spec is a Studio picture or video tool's (its `kind` is a pair of values, so a plain `===` does not narrow it away). */
export function isMediaSpec(spec: AiToolInputSpec): spec is MediaInputSpec {
  return spec.kind === 'image' || spec.kind === 'video';
}

/** Whether the tool's listing switch and every setting it requires are on (AITOOLS-08, AITOOLS-13). A tool with none is always listed. */
export function isListed(
  tool: Pick<AiTool, 'listingSetting' | 'requiredSettings'>,
  settings: Pick<AiToolSettings, 'number'>,
): boolean {
  if (tool.listingSetting && settings.number(tool.listingSetting) !== 1)
    return false;
  return (tool.requiredSettings ?? []).every((k) => settings.number(k) === 1);
}

/** A tool's settings keys, read on each call (R-65). */
export interface AiToolSettings {
  number(key: string): number;
  /** A setting that holds a list of lines (the languages Dubbing offers). */
  lines(key: string): string[];
}

export interface AiTool {
  readonly id: AiToolId;
  /** The plan's action id (`points.action.<id>`), which names the cost. Stored in the job's `tool` column. */
  readonly action: string;
  readonly name: string;
  /** One line under the name. */
  readonly description: string;
  /** What `costPointsPerUnit` is counted per. */
  readonly unit: AiToolUnit;
  /** What the job takes in and the settings that bound it. */
  readonly input: AiToolInputSpec;
  /** Where the job's audio is stored (a folder of the Hub's own, recorded as the person's); null for a tool that makes no audio (Captions). */
  readonly audioFolder: AiAudioFolder | null;
  /** The extension of the audio this tool stores when it is not `mp3` (Dubbing: `flac`). */
  readonly audioExtension?: string;
  /**
   * AITOOLS-13: a tool priced by more than one plan action (the Podcast maker has one for each length). `action` is the
   * first; `actionFor` picks the one a request is priced by, and a job row keeps the picked one.
   */
  readonly alsoActions?: readonly string[];
  actionFor?(req: AiToolRequest): string;
  /**
   * AITOOLS-13: the pipeline records the job and returns, and a follower makes it (an Audiobook is spoken one chapter at
   * a time, a Podcast is made at the provider); nothing runs in the request. `run` is then only the first step.
   */
  /** Where the job's picture or video is stored (AITOOLS-09, AITOOLS-10); absent for every tool that makes audio or words. */
  readonly mediaFolder?: AiMediaFolder;
  /**
   * The setting that lists the tool (`ai.listed.<id>`, AITOOLS-08, default off): the catalogue lists the tool only while
   * its code is built, the provider is set up for it AND this setting is 1. Absent for the seven older tools, which
   * list as soon as they can run.
   */
  readonly listingSetting?: string;
  /** AITOOLS-13: further settings that must be 1 for the tool to be listed and run (the Podcast maker's Studio API switch). */
  readonly requiredSettings?: readonly string[];
  /**
   * Whether the catalogue lists the tool while the provider is not set up
   * (`enabled: false`). VoiceOver keeps AITOOLS-01's answer; a tool added
   * through the pipeline is listed only when it can run (R-47).
   */
  readonly listedWhenOff: boolean;
  /** True when the provider can run this tool now. */
  enabled(provider: AiVoiceProvider): boolean;
  /**
   * Refuses a request that is over a limit the tool's own settings set (a
   * description too long, a length too long), naming the limit. Runs before
   * anything is priced or held, so a refusal holds nothing. Absent for a tool
   * whose only limits are the plan's caps, which the hold checks.
   */
  check?(
    req: AiToolRequest,
    settings: AiToolSettings,
    plan: Pick<PlansConfig, 'caps'>,
  ): void;
  /**
   * Refuses a request on its own words before the person's file is opened
   * (Dubbing: a language that is not on the list), so a refusal costs no read.
   * Returns the request with its values set to the form the tool uses (a
   * language tag in the list's own spelling). Nothing is held when it throws.
   */
  precheck?(req: AiToolRequest, settings: AiToolSettings): AiToolRequest;
  /**
   * AITOOLS-11 and -12: refuses the person's file on what the Hub read from it (an audio file where a video is
   * needed, a recording too short or too long, a file over the provider's own size), naming the limit. Runs for the
   * quote and for the job, before anything is priced or held.
   */
  checkFile?(
    opened: {
      contentType: string;
      seconds: number;
      bytes: number;
      minutes: number;
    },
    settings: AiToolSettings,
  ): void;
  /** The units a quote for the person's file is priced in; absent: the minutes of the file (Captions, Clean audio, Dubbing). */
  quoteUnits?(opened: { seconds: number; minutes: number }): number;
  /**
   * Prices the request into the plan's units for the hold. `characters` is
   * what the caps count. Pure.
   */
  price(
    req: AiToolRequest,
    settings: AiToolSettings,
    plan: Pick<PlansConfig, 'caps'>,
  ): { units: number; characters: number };
  /**
   * The one provider call. A network call: the caller holds no transaction,
   * no connection and no lock while it runs. Throws `AiVoiceProviderError`.
   */
  run(
    provider: AiVoiceProvider,
    job: Pick<AiToolJob, 'id' | 'voiceId'>,
    req: AiToolRequest,
    input?: AiToolRunInput,
  ): Promise<AiToolRunResult>;
}
