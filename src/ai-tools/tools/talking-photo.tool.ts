import { AI_VIDEO_FOLDER } from '../media/ai-media-store';
import { startWithAssets } from '../media/media-run';
import { asMedia, type AiTool, type MediaInputSpec } from './ai-tool';
import { checkMediaLimits } from './media-limits';

/** The plan's action a Talking photo job is priced by (a price for each second of speech, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const TALKING_PHOTO_ACTION = 'talking_photo_per_sec';
export const TALKING_PHOTO_MODEL_SETTING = 'ai.talking_photo_model';
export const TALKING_PHOTO_RESOLUTION_SETTING = 'ai.talking_photo_resolution';
/** The longest speech one job takes, in seconds. The provider's own limit is NOT KNOWN. */
export const TALKING_PHOTO_MAX_SECONDS_SETTING = 'ai.talking_photo_max_seconds';

const INPUT: MediaInputSpec = {
  kind: 'video',
  maxCharactersSetting: null,
  // The video follows the photo's own shape.
  shapes: [],
  photo: 'required',
  speech: { maxSecondsSetting: TALKING_PHOTO_MAX_SECONDS_SETTING },
};

/**
 * Talking photo (AITOOLS-10, R-109): a photo and a voice become a video of the
 * photo speaking. The voice is the person's own recording, or the audio of a
 * finished voice result of theirs; it does not run text to speech inside this
 * tool (one provider call and one price per tool). Both files are sent up as
 * assets for this one run and deleted when the job ends. The speech's length is
 * read by the Hub itself and prices the job; over the setting it is refused
 * before anything is held. Priced by the second of speech, by its own setting
 * (R-65).
 */
export const TALKING_PHOTO_TOOL: AiTool = {
  id: 'talking-photo',
  action: TALKING_PHOTO_ACTION,
  name: 'Talking photo',
  description: 'Make your photo speak with a voice.',
  unit: 'second',
  input: INPUT,
  audioFolder: null,
  mediaFolder: AI_VIDEO_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.talking-photo',
  enabled: (provider) => provider.mediaToolsConfigured,
  precheck: (req, settings) => ({
    ...asMedia(req),
    model: settings.lines(TALKING_PHOTO_MODEL_SETTING)[0],
    resolution: settings.lines(TALKING_PHOTO_RESOLUTION_SETTING)[0],
  }),
  check: (req, settings) => checkMediaLimits(INPUT, req, settings),
  // The speech's seconds, rounded up, at least 1: the Hub's own reading of the file.
  price: (req) => ({
    units: Math.max(1, asMedia(req).seconds ?? 1),
    characters: 0,
  }),
  run: async (provider, _job, req, input) => {
    const r = asMedia(req);
    const photo = input?.media?.photo;
    const speech = input?.media?.speech;
    if (!photo || !speech)
      throw new Error('a talking photo was run without its photo or voice');
    return startWithAssets(
      provider,
      input,
      'video',
      { photo, speech },
      (ids) => {
        if (!ids.photo || !ids.speech)
          throw new Error('a talking photo lost an asset');
        return provider.startVideo({
          kind: 'talking',
          model: r.model,
          resolution: r.resolution,
          imageAssetId: ids.photo,
          audioAssetId: ids.speech,
        });
      },
    );
  },
};
