import { AiToolError } from '../ai-tools-error';
import { AI_AUDIOBOOK_FOLDER } from '../audio/ai-audio-store';
import { bookRef } from '../audiobook/audiobook-support';
import { chunkBook, normalizeBook } from '../audiobook/audiobook-chunks';
import { asText, type AiTool, type TextInputSpec } from './ai-tool';

/** The plan's action an Audiobook is priced by (a price a minute, counted in characters, PROVISIONAL, the owner sets it). */
export const AUDIOBOOK_ACTION = 'audiobook_per_min';
export const AUDIOBOOK_CHARS_PER_MINUTE_SETTING =
  'ai.audiobook_chars_per_minute';
export const AUDIOBOOK_MAX_CHARS_SETTING = 'ai.audiobook_max_chars';
export const AUDIOBOOK_CHUNK_CHARS_SETTING = 'ai.audiobook_chunk_chars';
export const AUDIOBOOK_MAX_RUN_SETTING = 'ai.audiobook_max_run_minutes';
export const AUDIOBOOK_MODEL_SETTING = 'ai.audiobook_model';

export const AUDIOBOOK_EMPTY_MESSAGE =
  'Paste the text you want read, or choose a text file. No points were taken.';

const INPUT: TextInputSpec = {
  kind: 'text',
  charactersPerUnitSetting: AUDIOBOOK_CHARS_PER_MINUTE_SETTING,
  maxCharactersSetting: AUDIOBOOK_MAX_CHARS_SETTING,
};

/**
 * Audiobook (AITOOLS-13, R-109): a long text becomes one audio file. The Hub cuts the text into chapters (at a heading
 * or under the speech model's limit), speaks them one after the other on the speech route VoiceOver uses, each with the
 * words before and after it so the voice carries over, and joins them into one file. It takes minutes, so the job stays
 * `working` while a follower speaks the chapters; the points for the whole text are held up front. Priced like
 * VoiceOver, by characters over a minute (a setting): no text a person reads may state a price.
 */
export const AUDIOBOOK_TOOL: AiTool = {
  id: 'audiobook',
  action: AUDIOBOOK_ACTION,
  name: 'Audiobook',
  description: 'Turn a long text into one audio file.',
  unit: 'minute',
  input: INPUT,
  audioFolder: AI_AUDIOBOOK_FOLDER,
  mediaFolder: AI_AUDIOBOOK_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.audiobook',
  enabled: (provider) => provider.configured,
  precheck: (req, settings) => ({
    ...asText(req),
    model: settings.lines(AUDIOBOOK_MODEL_SETTING)[0],
    chunkChars: settings.number(AUDIOBOOK_CHUNK_CHARS_SETTING),
  }),
  check: (req, settings) => {
    const r = asText(req);
    if (normalizeBook(r.text) === '')
      throw new AiToolError('ai_text_empty', AUDIOBOOK_EMPTY_MESSAGE);
    const max = settings.number(AUDIOBOOK_MAX_CHARS_SETTING);
    const used = Array.from(r.text).length;
    if (used > max)
      throw new AiToolError(
        'ai_prompt_too_long',
        `An audiobook can have ${max} characters. This text has ${used}. No points were taken.`,
        { cap: 'audiobook_characters', capLimit: max, capUnit: 'characters' },
      );
  },
  price: (req, settings) => {
    const r = asText(req);
    const characters = Array.from(r.text).length;
    const perMinute = settings.number(AUDIOBOOK_CHARS_PER_MINUTE_SETTING);
    return {
      units: Math.max(1, Math.ceil(characters / perMinute)),
      characters,
    };
  },
  // The first and only step in the request: the Hub notes how many chapters there are and the follower speaks them.
  run: (_provider, _job, req) => {
    const r = asText(req);
    const chunkChars = r.chunkChars ?? 9000;
    const chapters = chunkBook(r.text, chunkChars).length;
    if (chapters < 1) return Promise.resolve({ failure: 'text_empty' });
    return Promise.resolve({ follow: { ref: bookRef(chapters, chunkChars) } });
  },
};
