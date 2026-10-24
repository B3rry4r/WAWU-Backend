/**
 * Sales the earnings sweep will never pay because they were made before its
 * start (WALLET-16, lead ruling 17 Oct 2026), listed for an admin.
 */
export interface UnsweptSaleView {
  paymentId: string;
  kind: string;
  targetId: string;
  title: string;
  payeeWawuUserId: string;
  /** The payee's 85% of the sale, in kobo: what the sweep would have moved. */
  payeeShareKobo: number;
  completedAt: string;
}

export interface UnsweptSalesPage {
  /** The moment from which the sweep pays sales. */
  startsAt: string;
  /** `config` when EARNINGS_SWEEP_START set it, else `first_run`. */
  source: 'config' | 'first_run';
  /**
   * How many such sales there are in all. Not called `total`: the response
   * interceptor takes any `items` plus a numeric `total` for an offset page
   * and rewrites it, which dropped the cursor and the start (B1 check, F1).
   */
  count: number;
  items: UnsweptSaleView[];
  /** A cursor page (CONVENTIONS section 6): pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

/**
 * Earnings a person has to look at (OPS-26, lead ruling 24 Oct 2026, the owner
 * may override): the rows R-55 sends out of the sweep. A refused daily move
 * goes to review 72 hours after the wallet first refused it; a single earning
 * goes when its sale is no longer a finished one or is above the cap.
 *
 * Read only. The amount is the row's own, in kobo; it is never added up
 * across rows into a balance. The provider's balance is the truth.
 */
export type EarningInReviewKind = 'daily_move' | 'earning';

export interface EarningInReviewView {
  /** The row's id: a daily move's, or a single earning's (`kind` says which). */
  id: string;
  kind: EarningInReviewKind;
  payeeWawuUserId: string;
  /** In kobo, as the row holds it: the move's amount, or the earning's 85%. */
  amountKobo: number;
  /** How many earnings the row holds (1 for a single earning). */
  earnings: number;
  /** What was earned, for a single earning; null for a daily move. */
  title: string | null;
  /** The Lagos day (YYYY-MM-DD) a daily move was made on; null for a single earning. */
  dayKey: string | null;
  /** The wallet provider that took the sales (`fintava` or `nuvion`). */
  provider: string;
  /** When the wallet first refused a daily move; null when it never did, and for a single earning. */
  firstRefusedAt: string | null;
  /** When the row went to review. */
  reviewSince: string;
  /** Our own words for why a person has to look; null when none was written. */
  reason: string | null;
}

export interface EarningsInReviewPage {
  /**
   * How many rows are in review in all. Not called `total`: the response
   * interceptor takes any `items` plus a numeric `total` for an offset page
   * and rewrites it, which would drop the cursor.
   */
  count: number;
  /** Oldest first, so the one waiting longest comes first. */
  items: EarningInReviewView[];
  /** A cursor page (CONVENTIONS section 6): pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}
