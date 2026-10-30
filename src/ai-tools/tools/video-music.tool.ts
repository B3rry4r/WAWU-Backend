import { AiToolError } from '../ai-tools-error';
import { AI_VIDEO_MUSIC_FOLDER } from '../audio/ai-audio-store';
import { asFile, type AiTool, type FileInputSpec } from './ai-tool';
import { checkFileLimits } from './file-limits';
import {
  PROVIDER_VIDEO_MAX_BYTES,
  requireAtMostBytes,
  requireAtMostSeconds,
  requireKind,
} from './file-checks';
import { AI_INPUT_MAX_BYTES_SETTING } from '../../storage/dto/presign-upload.dto';

/** The plan's action a Music for a video job is priced by (a flat price a track, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const VIDEO_MUSIC_ACTION = 'video_music_per_track';
export const VIDEO_MUSIC_MAX_SECONDS_SETTING = 'ai.video_music_max_seconds';
export const VIDEO_MUSIC_MAX_PROMPT_CHARS_SETTING =
  'ai.video_music_max_prompt_chars';

const INPUT: FileInputSpec = {
  kind: 'file',
  languageCode: false,
  only: 'video',
  description: { maxCharactersSetting: VIDEO_MUSIC_MAX_PROMPT_CHARS_SETTING },
  maxSecondsSetting: VIDEO_MUSIC_MAX_SECONDS_SETTING,
};

/**
 * Music for a video (AITOOLS-12, R-109): the person's own video goes in, with the mood in words if they like, and music
 * made for it comes back as an AUDIO file. The provider returns music only and the Hub has no tool to put it on the
 * video, so the result is audio, and the screen says so plainly. One long synchronous call, like Music track. Priced
 * flat, one track, by its own setting: no text a person reads may state or imply a price. A 403 from the provider (the
 * plan does not cover the music routes) becomes "This isn't available right now. No points were taken."
 */
export const VIDEO_MUSIC_TOOL: AiTool = {
  id: 'video-music',
  action: VIDEO_MUSIC_ACTION,
  name: 'Music for a video',
  description: 'Get music made for your video.',
  unit: 'track',
  input: INPUT,
  audioFolder: AI_VIDEO_MUSIC_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.video-music',
  enabled: (provider) => provider.fileToolsConfigured,
  checkFile: (opened, settings) => {
    requireKind(opened, 'video');
    requireAtMostBytes(
      opened,
      Math.min(
        settings.number(AI_INPUT_MAX_BYTES_SETTING),
        PROVIDER_VIDEO_MAX_BYTES,
      ),
    );
    requireAtMostSeconds(
      opened,
      settings,
      VIDEO_MUSIC_MAX_SECONDS_SETTING,
      'video',
    );
  },
  check: (req, settings, plan) => {
    checkFileLimits(req, plan);
    const description = asFile(req).description;
    if (description) {
      const max = settings.number(VIDEO_MUSIC_MAX_PROMPT_CHARS_SETTING);
      const characters = Array.from(description).length;
      if (characters > max)
        throw new AiToolError(
          'ai_prompt_too_long',
          `Describe the mood in ${max} characters or fewer. This one has ${characters}. No points were taken.`,
          { cap: 'prompt_characters', capLimit: max, capUnit: 'characters' },
        );
    }
  },
  quoteUnits: () => 1,
  price: (req) => ({
    units: 1,
    characters: Array.from(asFile(req).description ?? '').length,
  }),
  run: async (provider, _job, req, input) => {
    const r = asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    return {
      audio: await provider.makeMusicForVideo({
        file: input.file,
        description: r.description ?? null,
      }),
    };
  },
};
