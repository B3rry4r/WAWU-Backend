import { asFile, type AiTool } from './ai-tool';
import { checkFileLimits, LENGTH_SLACK_SECONDS } from './file-limits';
import { buildSrt } from './subtitles';

/** The plan's action a Captions job is priced by (a price a minute of the file, PROVISIONAL, the PT1 tile). */
export const CAPTIONS_ACTION = 'captions_per_min';

/**
 * Captions (AITOOLS-04, PT1 "Captions"): a recording or video the person
 * uploaded goes in, the words and a subtitle file (SRT) come back. Priced by
 * the minute of the file, as the Hub reads it (rounded up, at least 1); the
 * price is the plan's own setting (R-65), so no text a person reads may state
 * or imply a price. After the result is stored the provider's copy of the
 * transcript is deleted, so it keeps no copy of a person's words.
 *
 * A length the provider reports that is more than a minute above the priced
 * one fails the job (every point back): the Hub never charges less than the
 * work, and never more than it quoted.
 */
export const CAPTIONS_TOOL: AiTool = {
  id: 'captions',
  action: CAPTIONS_ACTION,
  name: 'Captions',
  description: 'Turn what is said in a recording or video into words.',
  unit: 'minute',
  input: { kind: 'file', languageCode: true },
  audioFolder: null,
  listedWhenOff: false,
  enabled: (provider) => provider.fileToolsConfigured,
  check: (req, _settings, plan) => checkFileLimits(req, plan),
  price: (req) => ({ units: asFile(req).minutes, characters: 0 }),
  run: async (provider, _job, req, input) => {
    const { languageCode, minutes } = asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    const transcript = await provider.transcribe({
      file: input.file,
      languageCode,
    });
    const providerCopy =
      transcript.id === null
        ? undefined
        : ({ kind: 'transcript', id: transcript.id } as const);
    if (
      transcript.durationSeconds !== null &&
      transcript.durationSeconds > minutes * 60 + LENGTH_SLACK_SECONDS
    )
      return { failure: 'length_differs', providerCopy };
    return {
      texts: [
        { kind: 'text', text: transcript.text },
        {
          kind: 'subtitles',
          text: buildSrt(transcript.words, {
            text: transcript.text,
            durationSeconds: transcript.durationSeconds,
          }),
        },
      ],
      providerCopy,
    };
  },
};
