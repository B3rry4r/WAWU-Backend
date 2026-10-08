/**
 * What GET /plans and GET /me/tier answer (TIER-01). Every amount is a whole
 * number in the minor unit of the response's `currency`: kobo when it is
 * `NGN`, cents when it is `USD`. A response carries one currency only: a
 * person billed in naira is never shown a dollar price, and the reverse.
 */

/** The currency a person is billed in. */
export type PlanCurrency = 'NGN' | 'USD';

/** A Christmas event pass a tier issues (W44). */
export interface PlanEventPassView {
  id: string;
  name: string;
}

export interface PlanBadgeView {
  id: string;
  /** The badge carries a number (Founding Maker, VF7). */
  numbered: boolean;
}

/** One tier card (VF5). */
export interface PlanTierView {
  id: string;
  name: string;
  /** How long one purchase lasts, in days. */
  days: number;
  /** Products the tier lets a person publish. */
  products: number;
  bonusPoints: number;
  /** How long the bonus points last, in days. */
  bonusPointsExpireDays: number;
  /** Whole minor units of `currency`. */
  priceMinor: number;
  eventPass: PlanEventPassView;
  badge: PlanBadgeView;
  /** Extra points on points packs bought while on this tier, in percent. */
  packBonusPercent: number;
  firstVoiceIntroIncluded: boolean;
  /** VF5 shows this tier selected. */
  preselected: boolean;
}

/** Extra products bought on top of a tier (VF13, TIER-04). */
export interface PlanExtraProductsView {
  count: number;
  priceMinor: number;
}

/** One points pack (PT4). */
export interface PlanPackView {
  id: string;
  points: number;
  priceMinor: number;
}

/** The points offer on the tier checkout (VF6). */
export interface PlanCheckoutBumpView {
  points: number;
  priceMinor: number;
}

/** What an AI action costs in points, and per what (PT1). */
export interface PlanActionView {
  id: string;
  points: number;
  per: 'use' | 'minute' | 'track' | 'message' | 'minute_per_language';
}

/** The limits on AI jobs (PT7). */
export interface PlanCapsView {
  dailyPoints: number;
  maxCharactersPerJob: number;
  maxAudioMinutesPerJob: number;
}

/** GET /plans: the plan in the caller's billing currency only. */
export interface PlansView {
  currency: PlanCurrency;
  /** False until the caller's first purchase fixes the currency. */
  currencyFixed: boolean;
  tiers: PlanTierView[];
  extraProducts: PlanExtraProductsView;
  packs: PlanPackView[];
  checkoutBump: PlanCheckoutBumpView;
  actions: PlanActionView[];
  caps: PlanCapsView;
}

/**
 * `none`: never had a tier. `active`: publishing allowed. `ending`: still
 * active, ends within the config's `tier_ending_days`. `ended`: the period
 * is over; published products stay up, new publishing waits for a renewal.
 */
export type MyTierState = 'none' | 'active' | 'ending' | 'ended';

/** The tier a person holds, as VF14 shows it. */
export interface MyTierSummaryView {
  id: string;
  /** Null when the config no longer names this tier. */
  name: string | null;
  badge: PlanBadgeView | null;
}

/** GET /me/tier (VF14). */
export interface MyTierView {
  state: MyTierState;
  /** Null when `state` is `none`. */
  tier: MyTierSummaryView | null;
  activeFrom: string | null;
  /** The tier ends at this moment (ISO 8601). */
  activeUntil: string | null;
  /** The tier's products plus extra products bought (0 with no tier). */
  productsAllowed: number;
  extraProducts: number;
  /** The bonus points the tier came with. */
  pointsIncluded: number;
  firstVoiceIntroIncluded: boolean;
  /** The best event pass the person holds, or null. */
  eventPass: PlanEventPassView | null;
}
