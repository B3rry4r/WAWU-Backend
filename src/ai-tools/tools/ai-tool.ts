import type { AiToolJob } from '../../../generated/prisma/client';
import type { PlansConfig } from '../../plans/plans-config';
import type { AiVoiceProvider, SpokenAudio } from '../voice/ai-voice-provider';

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
export type AiToolId = 'voiceover' | 'quick-voice';

/** What a job takes in. `text` now; `prompt`, `file` and `chat` come with the tasks that need them. */
export type AiToolInputKind = 'text';

/** How a text request reads once the pipeline has checked it. */
export interface TextJobRequest {
  kind: 'text';
  text: string;
  voiceId: string;
}

export type AiToolRequest = TextJobRequest;

/** What one run of the provider gave back, before it is stored. */
export interface AiToolRunResult {
  /** Audio to keep under the job's key; stored and served as `outputs[].kind: audio` (and `audioUrl`). */
  audio?: SpokenAudio;
  /** Text outputs kept in the job row itself (`outputs[].text`). */
  texts?: { kind: 'text' | 'subtitles'; text: string }[];
  /** The provider's own id for a long job, kept for a later look-up (`providerRef`). */
  providerRef?: string;
}

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
  readonly unit: 'minute';
  /** The input's kind and the setting for characters that make one unit. */
  readonly input: {
    kind: AiToolInputKind;
    charactersPerUnitSetting: string;
  };
  /**
   * Whether the catalogue lists the tool while the provider is not set up
   * (`enabled: false`). VoiceOver keeps AITOOLS-01's answer; a tool added
   * through the pipeline is listed only when it can run (R-47).
   */
  readonly listedWhenOff: boolean;
  /** True when the provider can run this tool now. */
  enabled(provider: AiVoiceProvider): boolean;
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
