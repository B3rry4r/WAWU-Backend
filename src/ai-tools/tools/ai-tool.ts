import type { AiToolJob } from '../../../generated/prisma/client';
import type { PlansConfig } from '../../plans/plans-config';
import type {
  AiVoiceProvider,
  ProviderCopy,
  SpokenAudio,
  StreamedFile,
  VoiceSample,
} from '../voice/ai-voice-provider';
import type { AiAudioFolder } from '../audio/ai-audio-store';

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
  | 'clean-audio';

/** What a job takes in. `text` (words to speak), `prompt` (a description) and `file` (a recording or video the person uploaded, AITOOLS-04); `chat` comes with the task that needs it. */
export type AiToolInputKind = 'text' | 'prompt' | 'file';

/** How a text request reads once the pipeline has checked it. */
export interface TextJobRequest {
  kind: 'text';
  text: string;
  voiceId: string;
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
  /** The length the Hub read, in seconds. */
  seconds: number;
  /** Minutes the job is priced in: rounded up, at least 1. */
  minutes: number;
  bytes: number;
  contentType: string;
}

export type AiToolRequest = TextJobRequest | PromptJobRequest | FileJobRequest;

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
  /** Text outputs kept in the job row itself (`outputs[].text`). */
  texts?: { kind: 'text' | 'subtitles'; text: string }[];
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
}

/** What the pipeline hands a file tool's run: the person's file, streamed to the provider for this one run. */
export interface AiToolRunInput {
  file: VoiceSample | StreamedFile;
  /**
   * VoiceOver in the person's own voice (AITOOLS-07): notes the provider's copy
   * of the voice on the job as soon as it exists (answers `true` when it did),
   * so the pipeline removes it however the job ends. Absent for every other run.
   */
  noteCopy?: (copy: ProviderCopy) => Promise<boolean>;
}

/** What a unit of a tool's price is: a minute of speech, one use, or one track. */
export type AiToolUnit = 'minute' | 'use' | 'track';

/** A tool that takes words to speak: priced in minutes of speech, in one of the listed voices. */
export interface TextInputSpec {
  kind: 'text';
  /** The setting for the characters that make one unit. */
  charactersPerUnitSetting: string;
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
}

export type AiToolInputSpec = TextInputSpec | PromptInputSpec | FileInputSpec;

/** A tool's settings keys, read on each call (R-65). */
export interface AiToolSettings {
  number(key: string): number;
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
