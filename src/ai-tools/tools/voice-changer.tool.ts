import { AI_VOICE_CHANGER_FOLDER } from '../audio/ai-audio-store';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import { OWN_VOICE_ID } from '../own-voice/own-voice-id';
import { asFile, type AiTool, type FileInputSpec } from './ai-tool';
import { checkFileLimits } from './file-limits';
import { requireKind } from './file-checks';

/** The plan's action a Voice changer job is priced by (a price a minute of the recording, PROVISIONAL, the owner sets it). */
export const VOICE_CHANGER_ACTION = 'voice_changer_per_min';
/** The setting: the model Voice changer asks for. The provider's default; the multilingual model's id is NOT KNOWN. */
export const VOICE_CHANGER_MODEL_SETTING = 'ai.voice_changer_model';

const INPUT: FileInputSpec = {
  kind: 'file',
  languageCode: false,
  only: 'audio',
  voice: true,
};

/**
 * Voice changer (AITOOLS-11, R-109): a recording the person made goes in, the same words, timing and feeling come back
 * in another voice (a Hub voice, or their own saved clone, "Your voice"). One synchronous provider call, priced by the
 * minute of the recording as the Hub reads it. The recording is the person's own and is deleted when the job ends.
 * No text a person reads may state or imply a price.
 */
export const VOICE_CHANGER_TOOL: AiTool = {
  id: 'voice-changer',
  action: VOICE_CHANGER_ACTION,
  name: 'Voice changer',
  description: 'Say it again in another voice.',
  unit: 'minute',
  input: INPUT,
  audioFolder: AI_VOICE_CHANGER_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.voice-changer',
  enabled: (provider) => provider.configured,
  precheck: (req, settings) => ({
    ...asFile(req),
    model: settings.lines(VOICE_CHANGER_MODEL_SETTING)[0],
  }),
  checkFile: (opened) => requireKind(opened, 'audio'),
  check: (req, _settings, plan) => checkFileLimits(req, plan),
  price: (req) => ({ units: asFile(req).minutes, characters: 0 }),
  run: async (provider, job, req, input) => {
    const r = asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    const own = job.voiceId === OWN_VOICE_ID;
    if (own && !input.savedVoice)
      throw new AiVoiceProviderError('rejected', 'no saved voice');
    return {
      audio: await provider.changeVoice({
        file: input.file,
        voiceId: job.voiceId,
        ...(own ? { providerVoiceId: input.savedVoice } : {}),
        model: r.model ?? '',
      }),
    };
  },
};
