import { AI_VIDEO_FOLDER } from '../media/ai-media-store';
import { startWithAssets } from '../media/media-run';
import { asMedia, type AiTool, type MediaInputSpec } from './ai-tool';
import { AiToolError } from '../ai-tools-error';
import { clipLengthFits } from '../voice/ai-voice-provider';
import { checkMediaLimits, LENGTH_UNSUPPORTED_MESSAGE } from './media-limits';

/** The plan's action a Make a video job is priced by (a price for each second, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const VIDEO_ACTION = 'video_per_sec';
export const VIDEO_MAX_PROMPT_CHARS_SETTING = 'ai.video_max_prompt_chars';
export const VIDEO_MODEL_SETTING = 'ai.video_model';
export const VIDEO_RESOLUTION_SETTING = 'ai.video_resolution';
/** Whether the clip is made with sound (the provider's own default is on; its credit effect is NOT KNOWN). */
export const VIDEO_WITH_SOUND_SETTING = 'ai.video_with_sound';
/** How long a video may take before its points are given back (seconds); the same for Talking photo. */
export const VIDEO_MAX_RUN_SETTING = 'ai.video_max_run_seconds';
/** The lengths the model makes (docs/elevenlabs/API-FACTS.md, "Make a video"): 4, 6 or 8 seconds. */
export const VIDEO_LENGTHS = [4, 6, 8] as const;
/** Wide or tall. */
export const VIDEO_SHAPES = ['16:9', '9:16'] as const;

const INPUT: MediaInputSpec = {
  kind: 'video',
  maxCharactersSetting: VIDEO_MAX_PROMPT_CHARS_SETTING,
  shapes: VIDEO_SHAPES,
  lengths: VIDEO_LENGTHS,
  photo: 'optional',
};

/**
 * Make a video (AITOOLS-10, R-109): what happens, wide or tall, 4, 6 or 8
 * seconds, and optionally the person's own photo to start from (sent up as an
 * asset for this one run and deleted when the job ends). It takes minutes: the
 * job stays `working` while the Hub follows it, and a long job tells the
 * person when it ends (`ai_job_ready`). Priced by the second, by its own
 * setting (R-65): no text a person reads may state or imply a price.
 */
export const VIDEO_TOOL: AiTool = {
  id: 'video',
  action: VIDEO_ACTION,
  name: 'Make a video',
  description: 'Describe a short clip and get it.',
  unit: 'second',
  input: INPUT,
  audioFolder: null,
  mediaFolder: AI_VIDEO_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.video',
  enabled: (provider) => provider.mediaToolsConfigured,
  precheck: (req, settings) => {
    const r = asMedia(req);
    return {
      ...r,
      shape: r.shape ?? VIDEO_SHAPES[0],
      model: settings.lines(VIDEO_MODEL_SETTING)[0],
      resolution: settings.lines(VIDEO_RESOLUTION_SETTING)[0],
      withSound: settings.number(VIDEO_WITH_SOUND_SETTING) === 1,
    };
  },
  check: (req, settings) => {
    checkMediaLimits(INPUT, req, settings);
    // The length must also be one the model in the settings makes (provider truth), before anything is held.
    const r = asMedia(req);
    if (r.seconds !== null && !clipLengthFits(r.model, r.seconds))
      throw new AiToolError(
        'ai_length_unsupported',
        LENGTH_UNSUPPORTED_MESSAGE,
      );
  },
  price: (req) => {
    const r = asMedia(req);
    return { units: r.seconds ?? 1, characters: Array.from(r.prompt).length };
  },
  run: async (provider, _job, req, input) => {
    const r = asMedia(req);
    const photo = input?.media?.photo;
    return startWithAssets(
      provider,
      input,
      'video',
      photo ? { photo } : {},
      (ids) =>
        provider.startVideo({
          kind: 'clip',
          model: r.model,
          prompt: r.prompt,
          shape: r.shape ?? VIDEO_SHAPES[0],
          seconds: r.seconds ?? VIDEO_LENGTHS[0],
          resolution: r.resolution,
          withSound: r.withSound,
          startFrameAssetId: ids.photo,
        }),
    );
  },
};
