import {
  AI_AUDIO_CONTENT_TYPES,
  AI_CLEAN_FOLDER,
  type AiAudioContentType,
} from '../audio/ai-audio-store';
import { asFile, type AiTool } from './ai-tool';
import { checkFileLimits } from './file-limits';

/** The plan's action a Clean audio job is priced by (a price a minute of the file, PROVISIONAL, the PT1 tile). */
export const CLEAN_AUDIO_ACTION = 'clean_audio_per_min';

/**
 * Clean audio (AITOOLS-04, PT1 "Clean audio"): a recording or video the
 * person uploaded goes in, the same recording with the noise taken out comes
 * back as audio. Priced by the minute of the file, as the Hub reads it. The
 * answer's type is read from the real response: it is stored only if it is a
 * type the Hub serves, else the job fails and releases. The provider's history
 * item is deleted after the result is stored.
 *
 * What a real run answers is NOT KNOWN (no real run yet): the stand-in answers
 * `audio/mpeg`.
 */
export const CLEAN_AUDIO_TOOL: AiTool = {
  id: 'clean-audio',
  action: CLEAN_AUDIO_ACTION,
  name: 'Clean audio',
  description: 'Take the noise out of a recording or video.',
  unit: 'minute',
  input: { kind: 'file', languageCode: false },
  audioFolder: AI_CLEAN_FOLDER,
  listedWhenOff: false,
  enabled: (provider) => provider.fileToolsConfigured,
  check: (req, _settings, plan) => checkFileLimits(req, plan),
  price: (req) => ({ units: asFile(req).minutes, characters: 0 }),
  run: async (provider, _job, req, input) => {
    asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    const cleaned = await provider.isolateVoice({ file: input.file });
    const providerCopy =
      cleaned.historyId === null
        ? undefined
        : ({ kind: 'isolation', id: cleaned.historyId } as const);
    const type = (AI_AUDIO_CONTENT_TYPES as readonly string[]).includes(
      cleaned.contentType,
    )
      ? (cleaned.contentType as AiAudioContentType)
      : null;
    if (type === null) return { failure: 'output_type', providerCopy };
    return {
      audio: { audio: cleaned.audio, contentType: type },
      providerCopy,
    };
  },
};
