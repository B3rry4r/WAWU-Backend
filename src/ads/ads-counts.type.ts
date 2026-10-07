/** The three counts and the rate between them. */
export interface AdCounts {
  views: number;
  taps: number;
  skips: number;
  /**
   * Taps divided by views, as a fraction (0.25 is 25%), not rounded.
   * `null` when there are no views: a rate over nothing is not a number.
   */
  ctr: number | null;
}

/** One UTC day of one campaign. `day` is `YYYY-MM-DD`. */
export interface AdDayCounts {
  day: string;
  views: number;
  taps: number;
  skips: number;
}

/** A campaign's counts over a span of days (or all of them). */
export interface AdCampaignCounts {
  campaignId: string;
  /** The span's counts: the sum of `days`. Zeros when nothing was counted. */
  delivery: AdCounts;
  /** Oldest first. A day nothing was counted on has no entry. */
  days: AdDayCounts[];
}

/** Inclusive span of UTC days, both ends optional. Written `YYYY-MM-DD`. */
export interface AdDayRange {
  from?: string;
  to?: string;
}

/** One day where the daily totals and the raw events disagree. */
export interface AdCountMismatch {
  day: string;
  totals: Pick<AdCounts, 'views' | 'taps' | 'skips'>;
  events: Pick<AdCounts, 'views' | 'taps' | 'skips'>;
}
