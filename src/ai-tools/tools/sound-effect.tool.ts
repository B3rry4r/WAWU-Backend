import { AI_SFX_FOLDER } from '../audio/ai-audio-store';
import { asPrompt, type AiTool, type PromptInputSpec } from './ai-tool';
import { checkPromptLimits } from './prompt-limits';

/** The plan's action a Sound effect job is priced by (a flat price a use, PROVISIONAL, the PT1 tile). */
export const SFX_ACTION = 'sfx';
/** The setting: the longest description, in characters. */
export const SFX_MAX_PROMPT_CHARS_SETTING = 'ai.sfx_max_prompt_chars';
/** The setting: the longest sound, in seconds. */
export const SFX_MAX_SECONDS_SETTING = 'ai.sfx_max_seconds';
/**
 * The shortest sound the provider makes: 0.5 seconds (docs/elevenlabs/API-FACTS.md,
 * "Sound effects": the API page says 0.5, the overview 0.1; the Hub keeps to the API page).
 */
export const SFX_MIN_SECONDS = 0.5;

const INPUT: PromptInputSpec = {
  kind: 'prompt',
  maxCharactersSetting: SFX_MAX_PROMPT_CHARS_SETTING,
  length: {
    field: 'durationSeconds',
    minSeconds: SFX_MIN_SECONDS,
    maxSecondsSetting: SFX_MAX_SECONDS_SETTING,
    whole: false,
  },
  instrumental: false,
};

/**
 * Sound effect (AITOOLS-03, PT1 "Sound effect"): a description in words, one
 * provider call, one audio file out. Priced flat, one use, whatever the length
 * asked for, by its own setting (R-65), so no text a person reads may state or
 * imply a price.
 */
export const SOUND_EFFECT_TOOL: AiTool = {
  id: 'sound-effect',
  action: SFX_ACTION,
  name: 'Sound effect',
  description: 'Describe a sound and hear it.',
  unit: 'use',
  input: INPUT,
  audioFolder: AI_SFX_FOLDER,
  listedWhenOff: false,
  enabled: (provider) => provider.configured,
  check: (req, settings, plan) => checkPromptLimits(INPUT, req, settings, plan),
  price: (req) => ({
    units: 1,
    characters: Array.from(asPrompt(req).prompt).length,
  }),
  run: async (provider, _job, req) => {
    const { prompt, seconds } = asPrompt(req);
    return {
      audio: await provider.makeSoundEffect({
        prompt,
        durationSeconds: seconds,
      }),
    };
  },
};
