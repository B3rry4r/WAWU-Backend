import { AiToolError } from '../ai-tools-error';
import { AI_DIALOGUE_FOLDER } from '../audio/ai-audio-store';
import { OWN_VOICE_ID } from '../own-voice/own-voice-id';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import {
  asDialogue,
  type AiTool,
  type DialogueInputSpec,
  type DialogueJobRequest,
} from './ai-tool';

/** The plan's action a Dialogue job is priced by (a price a minute, counted in characters, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const DIALOGUE_ACTION = 'dialogue_per_min';
export const DIALOGUE_CHARS_PER_MINUTE_SETTING = 'ai.dialogue_chars_per_minute';
export const DIALOGUE_MAX_CHARS_SETTING = 'ai.dialogue_max_chars';
export const DIALOGUE_MODEL_SETTING = 'ai.dialogue_model';
/** The most different voices one scene has: the provider's own limit (docs/elevenlabs/API-FACTS.md, "Dialogue"). */
export const DIALOGUE_MAX_VOICES = 10;

export const DIALOGUE_EMPTY_MESSAGE =
  'Write at least one line for each voice. No points were taken.';
export const DIALOGUE_LINE_EMPTY_MESSAGE =
  'A line has no words in it. Write something or take the line out. No points were taken.';
export const DIALOGUE_TOO_MANY_VOICES_MESSAGE = `A scene can use up to ${DIALOGUE_MAX_VOICES} different voices. No points were taken.`;

const INPUT: DialogueInputSpec = {
  kind: 'dialogue',
  maxCharactersSetting: DIALOGUE_MAX_CHARS_SETTING,
  charactersPerUnitSetting: DIALOGUE_CHARS_PER_MINUTE_SETTING,
  maxVoices: DIALOGUE_MAX_VOICES,
};

/**
 * Dialogue (AITOOLS-11, R-109): the lines of a scene, each with the voice that says it, come back as one audio file.
 * Priced like VoiceOver, by characters over a minute (a setting), so no text a person reads may state a price. At most
 * 10 different voices and a set number of characters in all (the provider's own advice). The voices are the Hub's list
 * plus the person's own saved clone, which only its owner may name (`own`).
 */
export const DIALOGUE_TOOL: AiTool = {
  id: 'dialogue',
  action: DIALOGUE_ACTION,
  name: 'Dialogue',
  description: 'Write a scene and hear it in several voices.',
  unit: 'minute',
  input: INPUT,
  audioFolder: AI_DIALOGUE_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.dialogue',
  enabled: (provider) => provider.configured,
  precheck: (req, settings) => ({
    ...asDialogue(req),
    model: settings.lines(DIALOGUE_MODEL_SETTING)[0],
  }),
  check: (req, settings) => {
    const r = asDialogue(req);
    if (r.lines.length === 0)
      throw new AiToolError('ai_text_empty', DIALOGUE_EMPTY_MESSAGE);
    if (r.lines.some((l) => l.text === ''))
      throw new AiToolError('ai_text_empty', DIALOGUE_LINE_EMPTY_MESSAGE);
    if (new Set(r.lines.map((l) => l.voiceId)).size > DIALOGUE_MAX_VOICES)
      throw new AiToolError(
        'ai_voices_too_many',
        DIALOGUE_TOO_MANY_VOICES_MESSAGE,
        {
          cap: 'dialogue_voices',
          capLimit: DIALOGUE_MAX_VOICES,
          capUnit: 'voices',
        },
      );
    const max = settings.number(DIALOGUE_MAX_CHARS_SETTING);
    if (r.characters > max)
      throw new AiToolError(
        'ai_prompt_too_long',
        `A scene can have ${max} characters in all. This one has ${r.characters}. No points were taken.`,
        { cap: 'dialogue_characters', capLimit: max, capUnit: 'characters' },
      );
  },
  price: (req, settings) => {
    const r = asDialogue(req);
    const perMinute = settings.number(DIALOGUE_CHARS_PER_MINUTE_SETTING);
    return {
      units: Math.max(1, Math.ceil(r.characters / perMinute)),
      characters: r.characters,
    };
  },
  run: async (provider, _job, req, input) => {
    const r: DialogueJobRequest = asDialogue(req);
    const lines = r.lines.map((l) => {
      if (l.voiceId !== OWN_VOICE_ID)
        return { text: l.text, voiceId: l.voiceId };
      if (!input?.savedVoice)
        throw new AiVoiceProviderError('rejected', 'no saved voice');
      return {
        text: l.text,
        voiceId: l.voiceId,
        providerVoiceId: input.savedVoice,
      };
    });
    return { audio: await provider.makeDialogue({ lines, model: r.model }) };
  },
};
