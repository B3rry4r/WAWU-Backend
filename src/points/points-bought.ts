import type { PointLotSource } from '../../generated/prisma/enums';

/**
 * Bought points (R-101 point 7, owner, 27 Oct 2026: "Bought points cannot be
 * cashed out ... it can't expire ... This applies for the Play Store build
 * too"). Points a person paid for never end and can never be turned into
 * cash, on every platform. Earned and bonus points (a tier's bonus, a
 * referral, any free grant) keep their rules: they end, and they can be
 * cashed out at the set rate.
 *
 * A lot's `source` says which it is, and never changes:
 *  - `pack`: a points pack paid by the wallet, by bank transfer or in a store
 *    (the pack's own bonus points ride in the same lot, so they are bought);
 *  - `bump`: the points added at the tier checkout;
 *  - `shortfall`: the points a person topped up from the wallet to finish a job.
 */
export const BOUGHT_POINT_SOURCES: readonly PointLotSource[] = [
  'pack',
  'bump',
  'shortfall',
];

export function isBoughtSource(source: PointLotSource): boolean {
  return BOUGHT_POINT_SOURCES.includes(source);
}

/** Points of this source can be turned into cash (earned and bonus points only). */
export function isCashableSource(source: PointLotSource): boolean {
  return !isBoughtSource(source);
}

/**
 * The end stored on a lot that never ends. The column stays NOT NULL (and the
 * migration's CHECK keeps every end between 2000 and 2100), so a lot that
 * never ends carries this one far-away date, which sorts after every real end:
 * the expiry job never reaches it, a balance and a hold count it, and spending
 * by end date takes it last. Nothing shows this date: the views answer `null`.
 */
export const POINTS_NEVER_EXPIRES = new Date('2099-12-31T23:59:59.999Z');

/** True for a lot's end that is the "never ends" date (or later). */
export function endsNever(expiresAt: Date): boolean {
  return expiresAt.getTime() >= POINTS_NEVER_EXPIRES.getTime();
}

/** What a view says for a lot's end: an ISO time, or null for a lot that never ends. */
export function endOf(expiresAt: Date): string | null {
  return endsNever(expiresAt) ? null : expiresAt.toISOString();
}

/**
 * The order points are spent in (an AI tool's job): lots that end, soonest end
 * first (then the oldest grant, then the lot id), then the lots that never
 * end, oldest first. So nobody loses earned points to an end date while
 * holding bought ones. Before R-101 point 7 every lot, bought ones included,
 * ended after a set number of days and the soonest end went first. The sort
 * the queries use (`expiresAt`, `createdAt`, `id` ascending) gives exactly
 * this, because a lot that never ends carries the latest possible end.
 */
export const POINTS_SPEND_ORDER = [
  { expiresAt: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] as const;

/** What a person is told when they ask to cash out more than their earned and bonus points. No long dash. */
export const NOT_CASHABLE_WORDS =
  "Points you bought can't be turned into cash.";
