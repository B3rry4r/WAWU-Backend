import type { PlansConfig } from '../../plans/plans-config';
import { AiToolError } from '../ai-tools-error';
import { AI_PODCAST_FOLDER } from '../audio/ai-audio-store';
import { OWN_VOICE_ID } from '../own-voice/own-voice-id';
import { castRef } from '../podcast/podcast-support';
import {
  asPodcast,
  type AiTool,
  type AiToolSettings,
  type PodcastInputSpec,
  type PodcastJobRequest,
} from './ai-tool';

/** The plan's actions a Podcast is priced by, one for each length (PROVISIONAL, the owner sets them). */
export const PODCAST_ACTIONS = {
  short: 'podcast_short',
  standard: 'podcast_standard',
  long: 'podcast_long',
} as const;
export const PODCAST_MAX_CHARS_SETTING = 'ai.podcast_max_chars';
export const PODCAST_MODEL_SETTING = 'ai.podcast_model';
export const PODCAST_LANGUAGES_SETTING = 'ai.podcast_languages';
export const PODCAST_MAX_RUN_SETTING = 'ai.podcast_max_run_seconds';
/** The switch the lead turns on only after the provider's Studio API proof call passed for our account. */
export const PODCAST_STUDIO_OK_SETTING = 'ai.podcast_studio_api_ok';
/** A link is only `https`, at most this many characters; the Hub never fetches it (the provider does). */
export const PODCAST_LINK_MAX_CHARS = 2000;

export const PODCAST_LINK_MESSAGE =
  'Use a web link that starts with https and has a site name in it. No points were taken.';
export const PODCAST_SAME_VOICE_MESSAGE =
  'Pick two different voices for a conversation. No points were taken.';
export const PODCAST_EMPTY_MESSAGE =
  'Paste a text or a web link to make a podcast from. No points were taken.';
/** What a person reads when the provider's Studio API does not take our account (403): the owner reads the log. */
export const PODCAST_UNAVAILABLE_MESSAGE =
  "This isn't available right now. No points were taken.";

const INPUT: PodcastInputSpec = {
  kind: 'podcast',
  maxCharactersSetting: PODCAST_MAX_CHARS_SETTING,
  languagesSetting: PODCAST_LANGUAGES_SETTING,
};

/** The provider's name for a length: `short`, `default`, `long`. */
const PROVIDER_DURATION = {
  short: 'short',
  standard: 'default',
  long: 'long',
} as const;

/** The longest text a podcast is made from: the tool's own setting, or the plan's per-job character cap when that is lower. */
export function podcastMaxCharacters(
  settings: Pick<AiToolSettings, 'number'>,
  plan: Pick<PlansConfig, 'caps'>,
): number {
  return Math.min(
    settings.number(PODCAST_MAX_CHARS_SETTING),
    plan.caps.maxCharsPerJob,
  );
}

/** True for a link the provider may be given: https, a site name (not an address), no sign-in in it, short. */
export function podcastLinkOk(link: string): boolean {
  if (link.length === 0 || link.length > PODCAST_LINK_MAX_CHARS) return false;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hostname.includes('.') &&
    !/^\[|^[0-9.]+$/.test(url.hostname) &&
    url.hostname !== 'localhost'
  );
}

/**
 * Podcast maker (AITOOLS-13, R-109): a text or a web page becomes a podcast with one host or two voices. It runs on the
 * provider's Studio API, which only allowlisted accounts can use, so the tool is also unlisted until
 * `ai.podcast_studio_api_ok` is on, and a refusal from the provider (403) gives every point back and logs an owner item.
 * The provider works for minutes: the job stays `working` while a follower reads the project. Priced by its length
 * (three plan actions, PROVISIONAL): no text a person reads may state a price.
 */
export const PODCAST_TOOL: AiTool = {
  id: 'podcast',
  action: PODCAST_ACTIONS.standard,
  alsoActions: [PODCAST_ACTIONS.short, PODCAST_ACTIONS.long],
  actionFor: (req) => PODCAST_ACTIONS[asPodcast(req).duration],
  name: 'Podcast maker',
  description: 'Turn a text or a web page into a podcast.',
  unit: 'use',
  input: INPUT,
  audioFolder: AI_PODCAST_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.podcast',
  requiredSettings: [PODCAST_STUDIO_OK_SETTING],
  enabled: (provider) => provider.podcastConfigured && provider.configured,
  precheck: (req, settings) => {
    const r = asPodcast(req);
    return {
      ...r,
      language: r.language.trim().toLowerCase(),
      model: settings.lines(PODCAST_MODEL_SETTING)[0],
    };
  },
  check: (req, settings, plan) => {
    const r: PodcastJobRequest = asPodcast(req);
    if (r.source.type === 'text') {
      if (r.source.text.trim() === '')
        throw new AiToolError('ai_text_empty', PODCAST_EMPTY_MESSAGE);
      // The plan's per-job character cap bounds a podcast too (it is not a long-form exemption), so the limit a person
      // is told, and refused at, is the lower of the two: a text the hold would refuse is refused here, before the hold.
      const max = podcastMaxCharacters(settings, plan);
      if (r.characters > max)
        throw new AiToolError(
          'ai_prompt_too_long',
          `A podcast can be made from ${max} characters. This text has ${r.characters}. No points were taken.`,
          { cap: 'podcast_characters', capLimit: max, capUnit: 'characters' },
        );
    } else if (!podcastLinkOk(r.source.url)) {
      throw new AiToolError('ai_link_invalid', PODCAST_LINK_MESSAGE);
    }
    if (r.mode === 'conversation') {
      if (r.guestVoiceId === null || r.guestVoiceId === r.hostVoiceId)
        throw new AiToolError('ai_voices_same', PODCAST_SAME_VOICE_MESSAGE);
    }
    if (r.hostVoiceId === OWN_VOICE_ID || r.guestVoiceId === OWN_VOICE_ID)
      throw new AiToolError(
        'ai_voice_unknown',
        'Pick one of the voices on the list.',
      );
    const offered = settings
      .lines(PODCAST_LANGUAGES_SETTING)
      .map((l) => l.split(' ')[0].toLowerCase());
    if (!offered.includes(r.language))
      throw new AiToolError(
        'ai_language_unsupported',
        'That language is not on the list. No points were taken.',
      );
  },
  // One podcast of its length: a flat price (units 1) from the plan action of the length chosen.
  price: (req) => ({ units: 1, characters: asPodcast(req).characters }),
  run: async (provider, _job, req) => {
    const r = asPodcast(req);
    const started = await provider.startPodcast({
      model: r.model,
      mode: r.mode,
      hostVoiceId: r.hostVoiceId,
      guestVoiceId: r.mode === 'conversation' ? r.guestVoiceId : null,
      source: r.source,
      duration: PROVIDER_DURATION[r.duration],
      language: r.language,
    });
    return { follow: { ref: castRef(started.projectId) } };
  },
};
