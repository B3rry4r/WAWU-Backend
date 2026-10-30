import { AI_IMAGE_FOLDER } from '../media/ai-media-store';
import { startWithAssets } from '../media/media-run';
import { asMedia, type AiTool, type MediaInputSpec } from './ai-tool';
import { checkMediaLimits } from './media-limits';

/** The plan's action a Make an image job is priced by (a flat price a picture, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const IMAGE_ACTION = 'image_per_use';
/** The setting: the longest description, in characters. */
export const IMAGE_MAX_PROMPT_CHARS_SETTING = 'ai.image_max_prompt_chars';
export const IMAGE_MODEL_SETTING = 'ai.image_model';
export const IMAGE_RESOLUTION_SETTING = 'ai.image_resolution';
/** How long a picture may take before its points are given back (seconds). */
export const IMAGE_MAX_RUN_SETTING = 'ai.image_max_run_seconds';
/** The shapes the default model takes (docs/elevenlabs/API-FACTS.md, "Make an image"): square, portrait, tall and wide. */
export const IMAGE_SHAPES = ['1:1', '4:5', '9:16', '16:9'] as const;

const INPUT: MediaInputSpec = {
  kind: 'image',
  maxCharactersSetting: IMAGE_MAX_PROMPT_CHARS_SETTING,
  shapes: IMAGE_SHAPES,
  photo: 'none',
};

/**
 * Make an image (AITOOLS-09, R-109): a description and a shape, one picture
 * out. The provider makes it in the background (`POST /v1/flows/image`, then
 * reads), so the job stays `working` while the Hub follows it
 * (`AiFlowService`) and the person may leave. Priced flat, one picture, by its
 * own setting (R-65), so no text a person reads may state or imply a price.
 */
export const IMAGE_TOOL: AiTool = {
  id: 'image',
  action: IMAGE_ACTION,
  name: 'Make an image',
  description: 'Describe a picture and get it.',
  unit: 'use',
  input: INPUT,
  audioFolder: null,
  mediaFolder: AI_IMAGE_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.image',
  enabled: (provider) => provider.mediaToolsConfigured,
  precheck: (req, settings) => {
    const r = asMedia(req);
    return {
      ...r,
      shape: r.shape ?? IMAGE_SHAPES[0],
      model: settings.lines(IMAGE_MODEL_SETTING)[0],
      resolution: settings.lines(IMAGE_RESOLUTION_SETTING)[0],
    };
  },
  check: (req, settings) => checkMediaLimits(INPUT, req, settings),
  price: (req) => ({
    units: 1,
    characters: Array.from(asMedia(req).prompt).length,
  }),
  run: async (provider, _job, req, input) => {
    const r = asMedia(req);
    return startWithAssets(provider, input, 'image', {}, () =>
      provider.startImage({
        model: r.model,
        prompt: r.prompt,
        shape: r.shape ?? IMAGE_SHAPES[0],
        resolution: r.resolution,
        assetIds: [],
      }),
    );
  },
};
