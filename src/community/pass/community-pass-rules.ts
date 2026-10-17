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
    return `The monthly price must be at least N${(bounds.minKobo / 100).toLocaleString('en-NG')}.`;
  if (priceKobo > bounds.maxKobo)
    return `The monthly price can be at most N${(bounds.maxKobo / 100).toLocaleString('en-NG')}.`;
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
