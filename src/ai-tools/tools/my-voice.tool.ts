import { asFile, type AiTool, type FileInputSpec } from './ai-tool';
import {
  CLONE_RECORDING_MAX_BYTES,
  requireAtMostBytes,
  requireAtMostSeconds,
  requireKind,
} from './file-checks';
import { AiToolError } from '../ai-tools-error';

/** The plan's action a Clone your own voice job is priced by (a price once, PROVISIONAL, the owner sets it). */
export const MY_VOICE_ACTION = 'voice_clone_once';
/** The name a clone is kept under at the provider: plain, the same for everyone, never the person's own words. */
export const CLONE_PROVIDER_NAME = 'wawu-voice';
export const CLONE_RECORDING_MIN_SECONDS_SETTING =
  'ai.clone_sample_min_seconds';
export const CLONE_RECORDING_MAX_SECONDS_SETTING =
  'ai.clone_sample_max_seconds';

const INPUT: FileInputSpec = {
  kind: 'file',
  languageCode: false,
  only: 'audio',
  clone: true,
  maxSecondsSetting: CLONE_RECORDING_MAX_SECONDS_SETTING,
};

/**
 * Clone your own voice (AITOOLS-11, R-109): a short recording of the person, made into a clone of their voice that the
 * Hub keeps until they remove it. The clone is the person's own voice only: they agree to the exact words the Hub
 * served (`GET /ai-tools/my-voice`, `consent.line`) and the words and the time are kept. One provider call. The
 * pipeline writes the person's reservation before the call (a double tap makes one clone), keeps the provider's id
 * the moment it answers, and gives the clone back (provider copy and row) when the job does not keep its points.
 * Priced once, by its own setting: no text a person reads may state or imply a price.
 */
export const MY_VOICE_TOOL: AiTool = {
  id: 'my-voice',
  action: MY_VOICE_ACTION,
  name: 'Clone your own voice',
  description: 'Keep a copy of your voice for your voice tools.',
  unit: 'use',
  input: INPUT,
  audioFolder: null,
  listedWhenOff: false,
  listingSetting: 'ai.listed.my-voice',
  enabled: (provider) => provider.fileToolsConfigured,
  checkFile: (opened, settings) => {
    requireKind(opened, 'audio');
    requireAtMostBytes(opened, CLONE_RECORDING_MAX_BYTES);
    requireAtMostSeconds(
      opened,
      settings,
      CLONE_RECORDING_MAX_SECONDS_SETTING,
      'recording for your voice',
    );
    const min = settings.number(CLONE_RECORDING_MIN_SECONDS_SETTING);
    if (opened.seconds < min)
      throw new AiToolError(
        'ai_length_too_short',
        `Record at least ${min} seconds of your voice. This one is ${Math.max(1, Math.floor(opened.seconds))}. No points were taken.`,
        { cap: 'length_seconds', capLimit: min, capUnit: 'seconds' },
      );
  },
  quoteUnits: () => 1,
  price: () => ({ units: 1, characters: 0 }),
  run: async (provider, _job, req, input) => {
    asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    const made = await provider.cloneVoice({
      name: CLONE_PROVIDER_NAME,
      file: input.file,
    });
    return { clone: { providerVoiceId: made.providerVoiceId } };
  },
};
