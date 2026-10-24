import type { AiToolJob } from '../../../generated/prisma/client';
import type { PlansConfig } from '../../plans/plans-config';
import type { AiVoiceProvider, SpokenAudio } from '../voice/ai-voice-provider';
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
export type AiToolId = 'voiceover' | 'quick-voice' | 'sound-effect' | 'music';

/** What a job takes in. `text` (words to speak) and `prompt` (a description); `file` and `chat` come with the tasks that need them. */
export type AiToolInputKind = 'text' | 'prompt';

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

export type AiToolRequest = TextJobRequest | PromptJobRequest;

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

export type AiToolInputSpec = TextInputSpec | PromptInputSpec;

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
  /** Where the job's audio is stored (a folder of the Hub's own, recorded as the person's). */
  readonly audioFolder: AiAudioFolder;
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
  ): Promise<AiToolRunResult>;
}
