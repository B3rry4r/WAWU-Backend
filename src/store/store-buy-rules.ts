import type { StoreIntentKind } from '../../generated/prisma/enums';
import { PAYEE_SHARE_BPS } from '../money/payments/payment-config';

/**
 * The rules of a ladder purchase that need no database (STORE-BUY-HUB, R-101).
 */

/**
 * How long an intent stays open: 60 minutes (Default (lead), owner may
 * override). Long enough to find a card and approve a purchase on the store's
 * sheet; short enough that an old intent is not a standing permission. The
 * intent is judged at the time of the STORE SALE, not the time the app posts
 * it (see `intentCoversSale`), so a payment that was slow to reach the Hub is
 * never lost.
 */
export const INTENT_TTL_MS = 60 * 60 * 1000;

/** A store's clock and ours are not the same clock: a sale up to this long after the expiry still counts. */
export const INTENT_SKEW_MS = 5 * 60 * 1000;

/** True when a store sale made at `soldAt` is covered by an intent that expires at `expiresAt`. */
export function intentCoversSale(expiresAt: Date, soldAt: Date): boolean {
  return soldAt.getTime() <= expiresAt.getTime() + INTENT_SKEW_MS;
}

/**
 * True when a store sale was made at or after the intent was created (less the
 * same clock difference): a payment made before the person started this
 * purchase is not this purchase's, so an older transaction cannot be re-posted
 * under a fresh intent (STORE-BUY-HUB round 3).
 */
export function saleAfterIntent(createdAt: Date, soldAt: Date): boolean {
  return soldAt.getTime() >= createdAt.getTime() - INTENT_SKEW_MS;
}

/** How long an intent that was never used is kept before the sweep deletes it: 7 days after it ran out. */
export const INTENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** When a new intent made at `now` expires. */
export function intentExpiry(now: Date): Date {
  return new Date(now.getTime() + INTENT_TTL_MS);
}

/** The creator's exactly-85% of a LIST price, in kobo (R-101 point 2; the one split, R-5), rounded down. */
export function creatorShareOfList(listPriceKobo: number): number {
  return Number((BigInt(listPriceKobo) * BigInt(PAYEE_SHARE_BPS)) / 10_000n);
}

/** The payment kind a ladder sale counts as in the creator's earnings streams. */
export const EARNING_KIND_OF: Record<StoreIntentKind, string> = {
  content: 'content_unlock',
  tip: 'tip',
  pass: 'community_pass',
  question: 'paid_dm',
};

/** What a creator waits after a store sale before WAWU pays them: 3 working days (R-101 point 4). */
export const PAYOUT_WORKING_DAYS = 3;

const DAY_MS = 86_400_000;
/** Lagos is UTC+1 all year (no summer time). */
const LAGOS_OFFSET_MS = 3_600_000;

/** The Lagos calendar date of an instant, `YYYY-MM-DD`. */
export function lagosDateKey(at: Date): string {
  return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Lagos weekday of an instant, 1 (Monday) to 7 (Sunday). */
function lagosWeekday(at: Date): number {
  const day = new Date(at.getTime() + LAGOS_OFFSET_MS).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * `from` plus `days` working days: Lagos time, Monday to Friday, weekends
 * skipped, the time of day kept. A sale on Thursday at 15:00 is payable on
 * Tuesday at 15:00 (Friday, Monday, Tuesday); one on Saturday or Sunday counts
 * from Monday, so it is payable on Wednesday. `holidays` is a set of Lagos
 * dates (`YYYY-MM-DD`) that do not count either; the admin holiday list is the
 * setting `store.holidays` (STORE-HOLIDAYS).
 */
export function addWorkingDays(
  from: Date,
  days: number,
  holidays: ReadonlySet<string> = new Set(),
): Date {
  let at = from;
  let left = days;
  while (left > 0) {
    at = new Date(at.getTime() + DAY_MS);
    if (lagosWeekday(at) <= 5 && !holidays.has(lagosDateKey(at))) left -= 1;
  }
  return at;
}

/**
 * When a creator's share of a sale made at `soldAt` may be paid: 3 working days
 * on, skipping weekends and the public holidays in `holidays` (the admin
 * setting `store.holidays`, STORE-HOLIDAYS).
 */
export function payableAt(
  soldAt: Date,
  holidays: ReadonlySet<string> = new Set(),
): Date {
  return addWorkingDays(soldAt, PAYOUT_WORKING_DAYS, holidays);
}
