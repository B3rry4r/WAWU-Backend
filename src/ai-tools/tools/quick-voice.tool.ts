import { AI_AUDIO_FOLDER } from '../audio/ai-audio-store';
import { asText, type AiTool, type AiToolRequest } from './ai-tool';
import { minutesOfText } from './voiceover.tool';
import type { AiVoiceProvider } from '../voice/ai-voice-provider';

/** The plan's action a Quick voice job is priced by (125 a minute, PROVISIONAL, the PT1 tile). */
export const QUICK_VOICE_ACTION = 'quick_voice_per_min';
/** The setting: characters that make one minute of Quick voice. */
export const QUICK_VOICE_CHARS_PER_MINUTE_SETTING =
  'ai.quick_voice_chars_per_minute';

/**
 * Quick voice (AITOOLS-02, PT1 "Quick voice, 125 a minute"; owner, 23 Oct
 * 2026): a fast read-aloud. The same voices as VoiceOver on the provider's
 * faster model (`speakQuick`), priced by its own setting (R-65), so no text a
 * person reads may state or imply a price. The other reading
 * of the tile, a person's own voice from a short recording, is "Your voice"
 * on PT2 (VOICE-01), and the owner's answer is G-AITOOLS-02-1.
 */
export const QUICK_VOICE_TOOL: AiTool = {
  id: 'quick-voice',
  action: QUICK_VOICE_ACTION,
  name: 'Quick voice',
  description: 'A fast read of your words.',
  unit: 'minute',
  input: {
    kind: 'text',
    charactersPerUnitSetting: QUICK_VOICE_CHARS_PER_MINUTE_SETTING,
  },
  audioFolder: AI_AUDIO_FOLDER,
  listedWhenOff: false,
  enabled: (provider) => provider.configured,
  price: (req: AiToolRequest, settings) =>
    minutesOfText(
      asText(req).text,
      settings,
      QUICK_VOICE_CHARS_PER_MINUTE_SETTING,
    ),
  run: async (provider: AiVoiceProvider, job, req) => ({
    audio: await provider.speakQuick({
      voiceId: job.voiceId,
      text: asText(req).text,
    }),
  }),
};
