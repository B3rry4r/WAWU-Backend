import { PAYEE_SHARE_BPS } from '../../money/payments/payment-config';

/**
 * The rules of a private community's monthly pass that need no database
 * (task INBOX-24, R-63).
 *
 * A person pays for 30 days from the wallet. Nothing is debited by itself: a
 * pass ends, a reminder comes 3 days before, and the next pass is another
 * payment the person confirms with their PIN. The host sets the price and
 * keeps 85% (R-5, taken by the payment service, never here).
 */

/** The payment kind a pass is sold as (docs/contract/WALLET.md). */
export const COMMUNITY_PASS_KIND = 'community_pass';

/** The route a pass purchase's Idempotency-Key is scoped to. */
export const COMMUNITY_PASS_ROUTE = 'POST communities/:id/pass';

/** One pass is 30 days (R-63). */
export const PASS_PERIOD_DAYS = 30;

/** The reminder comes this many days before the pass ends (R-63). */
export const PASS_REMINDER_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * Default (agent), owner may override: the host's price is a whole figure
 * between these bounds, in kobo. R-63 names no bound; the launch example is
 * N2,000. Both can be changed by setting COMMUNITY_PASS_MIN_KOBO or
 * COMMUNITY_PASS_MAX_KOBO.
 */
export const DEFAULT_PASS_MIN_KOBO = 10_000;
export const DEFAULT_PASS_MAX_KOBO = 50_000_000;

export interface PassPriceBounds {
  minKobo: number;
  maxKobo: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The bounds in force, from the environment or the defaults above. */
export function passPriceBounds(
  env: Record<string, string | undefined> = process.env,
): PassPriceBounds {
  const minKobo = positiveInt(
    env.COMMUNITY_PASS_MIN_KOBO,
    DEFAULT_PASS_MIN_KOBO,
  );
  const maxKobo = positiveInt(
    env.COMMUNITY_PASS_MAX_KOBO,
    DEFAULT_PASS_MAX_KOBO,
  );
  return { minKobo, maxKobo: Math.max(minKobo, maxKobo) };
}

/** Why a host's price is refused, or null when it is fine. */
export function passPriceProblem(
  priceKobo: number,
  bounds: PassPriceBounds,
): string | null {
  if (!Number.isSafeInteger(priceKobo) || priceKobo <= 0)
    return 'Set a monthly price above zero.';
  if (priceKobo < bounds.minKobo)
    return `The monthly price must be at least ₦${(bounds.minKobo / 100).toLocaleString('en-NG')}.`;
  if (priceKobo > bounds.maxKobo)
    return `The monthly price can be at most ₦${(bounds.maxKobo / 100).toLocaleString('en-NG')}.`;
  return null;
}

/**
 * When a pass bought now runs from and to. Paying again before the end
 * extends from the current end date; after it ends, from now (R-63).
 */
export function nextPassPeriod(
  now: Date,
  currentEnd: Date | null,
  days: number = PASS_PERIOD_DAYS,
): { startsAt: Date; endsAt: Date } {
  const startsAt =
    currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + days * DAY_MS),
  };
}

/** True while a pass that ends at `endsAt` still gives access. */
export function passIsActive(endsAt: Date | null, now: Date): boolean {
  return endsAt !== null && endsAt.getTime() > now.getTime();
}

/** The latest moment at which a pass is still inside the reminder window. */
export function reminderWindowEnd(now: Date): Date {
  return new Date(now.getTime() + PASS_REMINDER_DAYS * DAY_MS);
}

/** What the pass is called in the history and the receipt. */
export function passTitle(communityName: string): string {
  return `${communityName} · 30 day pass`;
}

/** The days a pass runs for, read back from the terms a payment was quoted with. */
export function passDaysFromTerms(
  terms: Readonly<Record<string, string | number | boolean>> | undefined,
): number {
  const days = terms?.periodDays;
  return typeof days === 'number' && Number.isInteger(days) && days > 0
    ? days
    : PASS_PERIOD_DAYS;
}

/**
 * What one pass gives back when the host removes the member (INBOX-25, R-71).
 * A day that has started counts as used, so a pass bought a moment ago has
 * `periodDays - 1` unused days; a pass that has not started has all of them;
 * a pass that has ended has none. The refund is the price paid, pro rata and
 * floored in kobo: price x whole unused days / pass days, where the pass days
 * are the pass's own period (its start to its end). Integer arithmetic only.
 */
export interface PassRefundFigures {
  periodDays: number;
  usedDays: number;
  unusedDays: number;
  refundKobo: bigint;
}

export function passRefundFigures(
  pass: { startsAt: Date; endsAt: Date; priceKobo: bigint },
  now: Date,
): PassRefundFigures {
  const periodDays = Math.max(
    1,
    Math.round((pass.endsAt.getTime() - pass.startsAt.getTime()) / DAY_MS),
  );
  const sinceStart = now.getTime() - pass.startsAt.getTime();
  const usedDays =
    now.getTime() >= pass.endsAt.getTime()
      ? periodDays
      : sinceStart <= 0
        ? 0
        : Math.min(periodDays, Math.ceil(sinceStart / DAY_MS));
  const unusedDays = periodDays - usedDays;
  const refundKobo =
    unusedDays > 0
      ? (pass.priceKobo * BigInt(unusedDays)) / BigInt(periodDays)
      : 0n;
  return { periodDays, usedDays, unusedDays, refundKobo };
}

/** The host's 85% of a refunded sum (R-5), rounded down as every share is. */
export function hostShareOfRefund(refundKobo: bigint): bigint {
  return (refundKobo * BigInt(PAYEE_SHARE_BPS)) / 10_000n;
}

/** The reference WAWU's refund of a removed member's pass goes out under. */
export function passRefundReference(refundId: string, attempt: number): string {
  const base = `wawu-pref-${refundId}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** What the provider sees on the move. Names nobody and nothing personal. */
export const PASS_REFUND_NARRATION = 'WAWU refund';
