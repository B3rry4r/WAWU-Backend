import type { EntityStage } from '../../money/opening/review-stage';

/**
 * Two read-only lists for support (OPS-26, lead ruling 24 Oct 2026, the owner
 * may override): wallet openings that are stuck, and identity holds. They are
 * read from `FintavaWalletOpening` (the table every provider's openings use)
 * and answer by WAWU account id: never a BVN, a hash, a phone number or a
 * name. Neither moves money, calls a provider or changes a row.
 */

/** Where the provider's own review of the person stands (null: none recorded). */
export type OpeningReviewStage = EntityStage | null;

/** The openings that can be stuck: the states in which WAWU waits. */
export type StuckOpeningState = 'opening' | 'unknown' | 'open' | 'conflict';

/** The openings that hold a BVN and that support can let go of. */
export type HeldOpeningState = 'review' | 'stopped';

export interface StuckOpeningView {
  wawuUserId: string;
  state: StuckOpeningState;
  /** Our own code for why the last attempt did not open the account; null when none. */
  failureCode: string | null;
  /** The wallet provider the opening is with (`fintava` or `nuvion`). */
  provider: string;
  /** Create requests sent so far. */
  attempts: number;
  /** When the current attempt began. */
  startedAt: string;
  stage: OpeningReviewStage;
}

export interface StuckOpeningsPage {
  /** An `opening`, `unknown` or `open` row is listed after this many minutes without finishing; a `conflict` row at once. */
  stuckAfterMinutes: number;
  /** How many openings are stuck in all (not `total`: the interceptor rewrites a page with both). */
  count: number;
  /** Oldest first. */
  items: StuckOpeningView[];
  nextCursor: string | null;
}

export interface IdentityHoldView {
  wawuUserId: string;
  state: HeldOpeningState;
  stage: OpeningReviewStage;
  failureCode: string | null;
  provider: string;
  /** When this account took the BVN claim it holds. */
  heldSince: string;
  /** When the opening last changed. */
  changedAt: string;
}

export interface IdentityHoldsPage {
  /** How many holds there are in all (not `total`, see above). */
  count: number;
  /** Longest held first. */
  items: IdentityHoldView[];
  nextCursor: string | null;
}
