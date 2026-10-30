import type { BillingCurrency } from '../../../generated/prisma/enums';
import {
  type ActionUnit,
  INT4_MAX,
  type MinorPrice,
  type PlanActionId,
  type PlansConfig,
  priceIn,
} from '../../plans/plans-config';
import { POINTS_LIMITS } from '../points-config';
import { PointsError } from '../points-error';
import type { PointsCapView } from './points-spend-view.type';

/**
 * What an AI tool costs in points and what stops it (task POINTS-03, PT1 to
 * PT3 and PT7). Pure: the live plan's figures in (R-65: every cost, cap and
 * rate is an admin setting, read on each call), a priced job or a cap out. No
 * cost, cap or rate is written in this file.
 *
 * Default (agent), owner may override:
 *  - A job is `units` of its action (minutes, tracks, messages or uses, as the
 *    plan counts that action). Dubbing is counted per minute for each
 *    language, so its `languages` multiply the cost; no other action takes
 *    languages.
 *  - The per-job caps are checked first, then the day's. The daily cap counts
 *    the points of the person's AI jobs held or spent since the Lagos day
 *    began (a job given back does not count), and the job that would pass it
 *    is refused whole: nothing is held.
 *  - A shortfall is sold at the pack rate (`points.price_kobo_per_1000`),
 *    rounded UP to a whole kobo so WAWU never sells below the rate.
 */

/** The words a held job is shown under ("Spent on VoiceOver"). No outside brand names (R-68). */
export const ACTION_TITLES: Record<PlanActionId, string> = {
  say_my_name: 'Say my name',
  voice_intro: 'Voice Intro',
  voiceover_per_min: 'VoiceOver',
  quick_voice_per_min: 'Quick voice',
  captions_per_min: 'Captions',
  clean_audio_per_min: 'Clean audio',
  music_per_track: 'Music',
  sfx: 'Sound effects',
  dub_standard_per_min_lang: 'Dubbing',
  dub_premium_per_min_lang: 'Premium dubbing',
  receptionist_message: 'Receptionist',
  receptionist_voice_per_min: 'Receptionist voice',
  image_per_use: 'Make an image',
  photo_edit_per_use: 'Edit a photo',
  video_per_sec: 'Make a video',
  talking_photo_per_sec: 'Talking photo',
};

export const UNKNOWN_ACTION_MESSAGE = 'We could not find that AI tool.';
export const TOO_BIG_JOB_MESSAGE =
  'That job needs more points than one job can take.';
export const LANGUAGES_MESSAGE = 'Languages only apply to dubbing.';

/** What a job asks for. */
export interface SpendRequest {
  action: string;
  /** How many of the action's unit: minutes, tracks, messages or uses. */
  units: number;
  /** Dubbing only: how many languages (1 when left out). */
  languages?: number;
  /** The text's length in characters, when the job takes text. */
  characters?: number;
}

/** A job, priced. */
export interface PricedJob {
  action: string;
  title: string;
  per: ActionUnit;
  /** The plan's points for one unit. */
  perUnitPoints: number;
  units: number;
  languages: number;
  characters: number | null;
  /** `perUnitPoints` times `units` (times `languages` for dubbing). */
  costPoints: number;
}

/** Prices a job from the live plan, or refuses it. */
export function priceJob(
  config: Pick<PlansConfig, 'actions'>,
  req: SpendRequest,
): PricedJob {
  const action = config.actions.find((a) => a.id === req.action);
  if (!action) throw new PointsError('points_invalid', UNKNOWN_ACTION_MESSAGE);
  const perLanguage = action.per === 'minute_per_language';
  const languages = req.languages ?? 1;
  if (!perLanguage && languages !== 1)
    throw new PointsError('points_invalid', LANGUAGES_MESSAGE);
  if (
    !Number.isSafeInteger(req.units) ||
    req.units < 1 ||
    !Number.isSafeInteger(languages) ||
    languages < 1
  )
    throw new PointsError(
      'points_invalid',
      'Units must be a whole number of 1 or more.',
    );
  const cost = action.points * req.units * languages;
  if (!Number.isSafeInteger(cost) || cost > POINTS_LIMITS.maxPoints)
    throw new PointsError('points_invalid', TOO_BIG_JOB_MESSAGE);
  return {
    action: action.id,
    title: ACTION_TITLES[action.id as PlanActionId] ?? action.id,
    per: action.per,
    perUnitPoints: action.points,
    units: req.units,
    languages,
    characters: req.characters ?? null,
    costPoints: cost,
  };
}

/** A number of minutes with its unit, singular for exactly 1: "1 minute", "2 minutes". */
function minutesText(n: number): string {
  return `${n} ${n === 1 ? 'minute' : 'minutes'}`;
}

/** The cap that stops a job, in words a person can act on (PT7). */
export function capStop(
  caps: PlansConfig['caps'],
  job: PricedJob,
  spentTodayPoints: number,
  resetsAt: Date,
): PointsCapView | null {
  if (job.characters !== null && job.characters > caps.maxCharsPerJob) {
    return {
      cap: 'characters_per_job',
      limit: caps.maxCharsPerJob,
      unit: 'characters',
      usedPoints: null,
      remainingPoints: null,
      resetsAt: null,
      message: `One job can take up to ${caps.maxCharsPerJob} characters. This one has ${job.characters}.`,
    };
  }
  const minutes =
    job.per === 'minute' || job.per === 'minute_per_language'
      ? job.units
      : null;
  if (minutes !== null && minutes > caps.maxAudioMinPerJob) {
    return {
      cap: 'minutes_per_job',
      limit: caps.maxAudioMinPerJob,
      unit: 'minutes',
      usedPoints: null,
      remainingPoints: null,
      resetsAt: null,
      message: `One job can run up to ${minutesText(caps.maxAudioMinPerJob)}. This one is ${minutesText(minutes)}.`,
    };
  }
  const remaining = Math.max(0, caps.dailyPointsPerUser - spentTodayPoints);
  if (job.costPoints > remaining) {
    const tooBig = job.costPoints > caps.dailyPointsPerUser;
    return {
      cap: 'daily',
      limit: caps.dailyPointsPerUser,
      unit: 'points',
      usedPoints: spentTodayPoints,
      remainingPoints: remaining,
      resetsAt: resetsAt.toISOString(),
      message: tooBig
        ? `This job needs ${job.costPoints} points, more than the daily limit of ${caps.dailyPointsPerUser} for AI tools.`
        : `That is over today's limit of ${caps.dailyPointsPerUser} points for AI tools. You have ${remaining} left today, and the count starts again at midnight.`,
    };
  }
  return null;
}

/** The throw for a cap, for the callers that hold points. */
export function capError(stop: PointsCapView): PointsError {
  return new PointsError('points_cap_reached', stop.message, {
    cap: stop.cap,
    capLimit: stop.limit,
    capUnit: stop.unit,
    ...(stop.usedPoints === null ? {} : { usedPoints: stop.usedPoints }),
    ...(stop.remainingPoints === null
      ? {}
      : { remainingPoints: stop.remainingPoints }),
    resetsAt: stop.resetsAt,
  });
}

/**
 * The price of `points` bought to cover a shortfall, in the minor unit of the
 * person's currency: the rate for a thousand points, pro rata, rounded up.
 * Null when the price does not fit a payment.
 */
export function shortfallPriceMinor(
  rate: MinorPrice,
  currency: BillingCurrency,
  points: number,
): number | null {
  const per1000 = BigInt(priceIn(rate, currency));
  const total = BigInt(points) * per1000;
  const price = (total + 999n) / 1000n;
  return price >= 1n && price <= BigInt(INT4_MAX) ? Number(price) : null;
}
