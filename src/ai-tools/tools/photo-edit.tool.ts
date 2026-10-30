import { AI_IMAGE_FOLDER } from '../media/ai-media-store';
import { startWithAssets } from '../media/media-run';
import { asMedia, type AiTool, type MediaInputSpec } from './ai-tool';
import {
  IMAGE_MAX_PROMPT_CHARS_SETTING,
  IMAGE_MODEL_SETTING,
  IMAGE_RESOLUTION_SETTING,
  IMAGE_SHAPES,
} from './image.tool';
import { checkMediaLimits } from './media-limits';

/** The plan's action an Edit a photo job is priced by (a flat price an edit, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const PHOTO_EDIT_ACTION = 'photo_edit_per_use';

const INPUT: MediaInputSpec = {
  kind: 'image',
  maxCharactersSetting: IMAGE_MAX_PROMPT_CHARS_SETTING,
  shapes: IMAGE_SHAPES,
  photo: 'required',
};

/**
 * Edit a photo (AITOOLS-09, R-109): the person's own photo and a change in
 * words, the edited picture back. The photo is sent up as an asset for this one
 * run and deleted when the job ends (the provider keeps no copy of it). The
 * shape is optional: left out, the picture keeps the photo's own.
 */
export const PHOTO_EDIT_TOOL: AiTool = {
  id: 'photo-edit',
  action: PHOTO_EDIT_ACTION,
  name: 'Edit a photo',
  description: 'Change your photo by describing the change.',
  unit: 'use',
  input: INPUT,
  audioFolder: null,
  mediaFolder: AI_IMAGE_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.photo-edit',
  enabled: (provider) => provider.mediaToolsConfigured,
  precheck: (req, settings) => ({
    ...asMedia(req),
    model: settings.lines(IMAGE_MODEL_SETTING)[0],
    resolution: settings.lines(IMAGE_RESOLUTION_SETTING)[0],
  }),
  check: (req, settings) => checkMediaLimits(INPUT, req, settings),
  price: (req) => ({
    units: 1,
    characters: Array.from(asMedia(req).prompt).length,
  }),
  run: async (provider, _job, req, input) => {
    const r = asMedia(req);
    const photo = input?.media?.photo;
    if (!photo) throw new Error('an edit was run without its photo');
    return startWithAssets(provider, input, 'image', { photo }, (ids) =>
      provider.startImage({
        model: r.model,
        prompt: r.prompt,
        // Left out, the picture follows the photo's own shape.
        shape: r.shape ?? 'auto',
        resolution: r.resolution,
        assetIds: ids.photo ? [ids.photo] : [],
      }),
    );
  },
};
