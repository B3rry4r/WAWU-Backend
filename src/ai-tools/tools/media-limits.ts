import { AiToolError } from '../ai-tools-error';
import {
  asMedia,
  type AiToolRequest,
  type AiToolSettings,
  type MediaInputSpec,
} from './ai-tool';

/**
 * The limits a Studio picture or video tool holds a request to (AITOOLS-09,
 * AITOOLS-10), read from its settings on each call (R-65). Each refusal happens
 * before anything is priced or held, so it names the limit and holds nothing.
 * No text names a price, a provider or a model (R-68, R-5).
 */
export const PHOTO_REQUIRED_MESSAGE =
  'Choose a photo first. No points were taken.';
export const SPEECH_REQUIRED_MESSAGE =
  'Add a voice recording, or pick one of your finished voice results. No points were taken.';
export const SPEECH_ONE_ONLY_MESSAGE =
  'Use a recording or a finished voice result, not both. No points were taken.';
export const SHAPE_UNSUPPORTED_MESSAGE =
  'Pick one of the shapes on the list. No points were taken.';
export const LENGTH_UNSUPPORTED_MESSAGE =
  'Pick one of the lengths on the list. No points were taken.';
export const PHOTO_UNREADABLE_MESSAGE =
  "We couldn't open that photo. Choose a JPEG, PNG or WebP picture. No points were taken.";
export const SPEECH_UNREADABLE_MESSAGE =
  "We couldn't read that voice. Use an MP3 or WAV recording. No points were taken.";

/** What a failed picture or video says when the provider refused it on its content. */
export const IMAGE_MODERATED_MESSAGE =
  "That picture can't be made. No points were taken.";
export const VIDEO_MODERATED_MESSAGE =
  "That video can't be made. No points were taken.";

export function checkMediaLimits(
  spec: MediaInputSpec,
  req: AiToolRequest,
  settings: AiToolSettings,
): void {
  const r = asMedia(req);
  if (spec.maxCharactersSetting !== null) {
    const characters = Array.from(r.prompt).length;
    const max = settings.number(spec.maxCharactersSetting);
    if (characters > max)
      throw new AiToolError(
        'ai_prompt_too_long',
        `Describe it in ${max} characters or fewer. This one has ${characters}. No points were taken.`,
        { cap: 'prompt_characters', capLimit: max, capUnit: 'characters' },
      );
  }
  if (r.shape !== null && !spec.shapes.includes(r.shape))
    throw new AiToolError('ai_shape_unsupported', SHAPE_UNSUPPORTED_MESSAGE);
  if (spec.lengths && (r.seconds === null || !spec.lengths.includes(r.seconds)))
    throw new AiToolError('ai_length_unsupported', LENGTH_UNSUPPORTED_MESSAGE);
  if (spec.photo === 'required' && r.photoKey === null)
    throw new AiToolError('ai_photo_required', PHOTO_REQUIRED_MESSAGE);
  if (spec.speech) {
    const given =
      (r.audioKey !== null ? 1 : 0) + (r.sourceJobId !== null ? 1 : 0);
    if (given === 0)
      throw new AiToolError('ai_speech_required', SPEECH_REQUIRED_MESSAGE);
    if (given > 1)
      throw new AiToolError('ai_speech_required', SPEECH_ONE_ONLY_MESSAGE);
    // The speech's length is read by the Hub once the file is opened; it is held to the setting then.
    if (r.speech) {
      const max = settings.number(spec.speech.maxSecondsSetting);
      if (r.speech.seconds > max)
        throw new AiToolError(
          'ai_length_too_long',
          `The longest voice is ${max} seconds. No points were taken.`,
          { cap: 'length_seconds', capLimit: max, capUnit: 'seconds' },
        );
    }
  }
}
