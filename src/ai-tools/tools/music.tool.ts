import { AI_MUSIC_FOLDER } from '../audio/ai-audio-store';
import { asPrompt, type AiTool, type PromptInputSpec } from './ai-tool';
import { checkPromptLimits } from './prompt-limits';

/** The plan's action a Music track job is priced by (a flat price a track, PROVISIONAL, the PT1 tile). */
export const MUSIC_ACTION = 'music_per_track';
/** The setting: the longest description, in characters. */
export const MUSIC_MAX_PROMPT_CHARS_SETTING = 'ai.music_max_prompt_chars';
/** The setting: the longest track, in seconds. */
export const MUSIC_MAX_SECONDS_SETTING = 'ai.music_max_seconds';
/** The shortest track the provider makes: 3 seconds (docs/elevenlabs/API-FACTS.md, "Music": 3,000 ms). */
export const MUSIC_MIN_SECONDS = 3;

const INPUT: PromptInputSpec = {
  kind: 'prompt',
  maxCharactersSetting: MUSIC_MAX_PROMPT_CHARS_SETTING,
  length: {
    field: 'lengthSeconds',
    minSeconds: MUSIC_MIN_SECONDS,
    maxSecondsSetting: MUSIC_MAX_SECONDS_SETTING,
    whole: true,
  },
  instrumental: true,
};

/**
 * Music track (AITOOLS-03, PT1 "Music track"): a description in words, an
 * optional length and an optional "no singing" switch, one long provider
 * call, one audio file out. Priced flat, one track, whatever the length, by
 * its own setting (R-65), so no text a person reads may state or imply a
 * price. The provider's terms for what a track may be used for are the
 * owner's to read (G-AITOOLS-03-1); nothing here decides it.
 */
export const MUSIC_TOOL: AiTool = {
  id: 'music',
  action: MUSIC_ACTION,
  name: 'Music track',
  description: 'Describe a track and get the music.',
  unit: 'track',
  input: INPUT,
  audioFolder: AI_MUSIC_FOLDER,
  listedWhenOff: false,
  enabled: (provider) => provider.promptToolsConfigured,
  check: (req, settings, plan) => checkPromptLimits(INPUT, req, settings, plan),
  price: (req) => ({
    units: 1,
    characters: Array.from(asPrompt(req).prompt).length,
  }),
  run: async (provider, _job, req) => {
    const { prompt, seconds, instrumental } = asPrompt(req);
    return {
      audio: await provider.makeMusic({
        prompt,
        lengthSeconds: seconds,
        instrumental: instrumental === true,
      }),
    };
  },
};
