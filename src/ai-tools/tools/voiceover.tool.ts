import { AI_AUDIO_FOLDER } from '../audio/ai-audio-store';
import {
  asText,
  type AiTool,
  type AiToolRequest,
  type AiToolSettings,
} from './ai-tool';
import { OWN_VOICE_ID } from '../own-voice/own-voice-id';
import {
  AiVoiceProviderError,
  type AiVoiceProvider,
  type ProviderCopy,
} from '../voice/ai-voice-provider';

/** The plan's action a VoiceOver job is priced by. */
export const VOICEOVER_ACTION = 'voiceover_per_min';
/** The setting: characters that make one minute of VoiceOver. */
export const CHARS_PER_MINUTE_SETTING = 'ai.voiceover_chars_per_minute';

/** Minutes a text is priced in: its characters over the setting, rounded up, at least 1. */
export function minutesOfText(
  text: string,
  settings: AiToolSettings,
  charsPerMinuteSetting: string,
): { units: number; characters: number } {
  const characters = Array.from(text).length;
  const perMinute = settings.number(charsPerMinuteSetting);
  return { units: Math.max(1, Math.ceil(characters / perMinute)), characters };
}

/**
 * VoiceOver (AITOOLS-01, PT2): words to spoken audio in a listed voice, on
 * the provider's standard model. The first entry of the registry; its route,
 * request, answer and behaviour are exactly AITOOLS-01's.
 */
export const VOICEOVER_TOOL: AiTool = {
  id: 'voiceover',
  action: VOICEOVER_ACTION,
  name: 'VoiceOver',
  description: 'Turn your words into spoken audio.',
  unit: 'minute',
  input: { kind: 'text', charactersPerUnitSetting: CHARS_PER_MINUTE_SETTING },
  audioFolder: AI_AUDIO_FOLDER,
  listedWhenOff: true,
  enabled: (provider) => provider.configured,
  price: (req: AiToolRequest, settings) =>
    minutesOfText(asText(req).text, settings, CHARS_PER_MINUTE_SETTING),
  run: async (provider: AiVoiceProvider, job, req, input) => {
    const text = asText(req).text;
    if (job.voiceId !== OWN_VOICE_ID)
      return { audio: await provider.speak({ voiceId: job.voiceId, text }) };
    // AITOOLS-07, "Your voice": the person's own recording makes the voice for
    // this one run (the pipeline read it from their own row, after they agreed).
    const sample = input?.file;
    if (!sample || 'stream' in sample)
      throw new AiVoiceProviderError('rejected', 'no recording');
    let made: ProviderCopy | null = null;
    const audio = await provider.speakInOwnVoice(
      { sample, text },
      {
        handOver: async (id) => {
          const noted =
            (await input.noteCopy?.({ kind: 'voice', id })) === true;
          if (noted) made = { kind: 'voice', id };
          return noted;
        },
      },
    );
    return { audio, ...(made ? { providerCopy: made } : {}) };
  },
};
