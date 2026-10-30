import { AiToolError } from '../ai-tools-error';
import type { AiToolSettings } from './ai-tool';

/**
 * What the Voice changer, Clone your own voice, Music for a video and Split a song hold the person's FILE to
 * (AITOOLS-11, AITOOLS-12), read from the file itself by the Hub. Every refusal names the limit and says that no
 * points were taken; no text names a price, a provider or a model (R-68).
 */
export const AUDIO_ONLY_MESSAGE =
  'Choose an audio recording for this one. No points were taken.';
export const VIDEO_ONLY_MESSAGE =
  'Choose a video for this one. No points were taken.';

/** The most a video sent to Music for a video may be: the provider takes 200 MB in all, whatever `ai.input_max_bytes` says. */
export const PROVIDER_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
/** The most a recording a clone is made from may be: a request bound, not a product figure (the length is the setting). */
export const CLONE_RECORDING_MAX_BYTES = 20 * 1024 * 1024;

export interface OpenedFileFacts {
  contentType: string;
  seconds: number;
  bytes: number;
  minutes: number;
}

export function requireKind(
  facts: OpenedFileFacts,
  only: 'audio' | 'video',
): void {
  if (!facts.contentType.startsWith(`${only}/`))
    throw new AiToolError(
      'ai_file_unreadable',
      only === 'audio' ? AUDIO_ONLY_MESSAGE : VIDEO_ONLY_MESSAGE,
    );
}

/** A length over a setting: `422 ai_length_too_long` naming the limit. */
export function requireAtMostSeconds(
  facts: OpenedFileFacts,
  settings: AiToolSettings,
  setting: string,
  what: string,
): void {
  const max = settings.number(setting);
  if (facts.seconds > max)
    throw new AiToolError(
      'ai_length_too_long',
      `The longest ${what} is ${max} seconds. This one is ${Math.ceil(facts.seconds)}. No points were taken.`,
      { cap: 'length_seconds', capLimit: max, capUnit: 'seconds' },
    );
}

export function requireAtMostBytes(facts: OpenedFileFacts, max: number): void {
  if (facts.bytes > max)
    throw new AiToolError(
      'ai_file_too_large',
      `That file is too big. The most is ${Math.max(1, Math.round(max / (1024 * 1024)))} MB. No points were taken.`,
      { cap: 'file_bytes', capLimit: max, capUnit: 'bytes' },
    );
}
