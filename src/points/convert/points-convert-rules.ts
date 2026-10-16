import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { POINTS_WORD, POINTS_WORD_TITLE } from '../points-words';

/**
 * The rules of turning points into cash that need no database (task
 * POINTS-04, R-43, R-31).
 *
 * A person asks to convert some of their points; the cash is worked out at
 * the config's rate (TIER-01), the points are held (POINTS-01, purpose
 * `cash_out`), WAWU's own account at the wallet provider pays the cash into
 * the person's wallet, and the hold is committed once the provider has
 * confirmed it. The machinery is the earning's landing (WALLET-16) and the
 * hold's release (MONEY-18) with one decision of its own: a move the provider
 * provably did not make gives the points back.
 */

/** Where a conversion stands: held until the provider confirmed the cash. */
export const CONVERSION_STATUSES = ['held', 'paid', 'cancelled'] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

/**
 * Where a conversion stands, as a caller is told:
 * - `paid`: the provider confirmed the cash in the wallet; the points are spent;
 * - `pending`: the points are held and the cash is not confirmed yet (not
 *   handed to the provider yet, or handed over and the answer is unknown); it
 *   is asked about by our reference and never sent again;
 * - `review`: a person has to look; the points stay held, the cash is not
 *   sent again;
 * - `cancelled`: the provider did not move the cash and the points went back
 *   to the lots they came from.
 */
export type ConversionState = 'paid' | 'pending' | 'review' | 'cancelled';

export interface ConversionResult {
  conversionId: string;
  state: ConversionState;
  status: ConversionStatus;
}

/** Where a pass of the sweep stopped, in the order (createdAt, id). */
export interface ConversionSweepCursor {
  at: Date;
  id: string;
}

/**
 * How long one pass of the sweep may keep reading pages (the hold sweep's
 * budget, MONEY-18 round 2, F4): a pass reads every due conversion by a
 * keyset cursor with no cap on the rows it looks at, stops only at the end
 * or when this much time is used, and hands the place it reached to the next
 * pass.
 */
export const CONVERSION_SWEEP_BUDGET_MS = 45_000;

/** Conversions the sweep reads at a time. */
export const CONVERSION_SWEEP_PAGE = 50;

/**
 * A conversion is left to the request that made it for this long: that
 * request is driving it, and a sweep that took it in the same moment would
 * only meet the lease and answer the person "pending". After it, a request
 * that died (a restart, a kill) is finished by the sweep.
 */
export const CONVERSION_SWEEP_GRACE_MS = 20_000;

/**
 * The config quotes the cash-out rate per 1,000 points (`cash_out.
 * per_1000_points`, TIER-01); this is that unit, not a figure of the plan.
 */
export const POINTS_PER_RATE_UNIT = 1000n;

/**
 * The cash for some points at the config's rate, in kobo, rounded down: a
 * person is never paid more than the rate says, and the part of a kobo that
 * is left stays with WAWU. The migration's CHECK holds the same sum.
 */
export function cashForPoints(
  points: number,
  per1000PointsKobo: number,
): bigint {
  return (BigInt(points) * BigInt(per1000PointsKobo)) / POINTS_PER_RATE_UNIT;
}

/**
 * The most points whose cash is within `capKobo`: the largest `p` with
 * `cashForPoints(p) <= capKobo`. Null when there is no cap.
 */
export function pointsWithinCap(
  capKobo: number | null,
  per1000PointsKobo: number,
): number | null {
  if (capKobo === null) return null;
  // cash(p) <= cap  <=>  p * rate < (cap + 1) * 1000  (floor division)
  const limit =
    ((BigInt(capKobo) + 1n) * POINTS_PER_RATE_UNIT - 1n) /
    BigInt(per1000PointsKobo);
  return limit > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(limit);
}

/**
 * Our reference at the provider: `wawu-pts-<conversion id>` (45 characters,
 * inside Nuvion's 64 for `unique_reference`). One conversion, one reference
 * for ever: a conversion the provider did not make is cancelled, and a new
 * request is a new conversion with a new reference.
 */
export function conversionReference(conversionId: string): string {
  return `wawu-pts-${conversionId}`;
}

/** What the provider sees on the move. Names nobody and nothing personal. */
export const CASH_OUT_NARRATION = 'WAWU points cash-out';

/** The hold's title on the person's points list (PT5 reads "Converting to cash" itself). */
export const CASH_OUT_HOLD_TITLE = `${POINTS_WORD_TITLE} to cash`;

/**
 * True when the provider's refusal PROVES nothing moved and no record exists:
 * a refusal that says so (`recordMayExist` false: its limits, a frozen wallet,
 * WAWU's account short, a body it refused), or a request that never reached
 * it (`requestNotSent`). Anything else, and anything that is not a provider
 * error at all, is an unknown outcome: asked about, never sent again.
 */
export function provedNothingMoved(e: unknown): e is WalletProviderError {
  return (
    e instanceof WalletProviderError && (!e.recordMayExist || e.requestNotSent)
  );
}

/** What the person is told, in plain words (no em-dash). */
export const CONVERSION_WORDS = {
  pending: `We're still confirming this. Your ${POINTS_WORD} are on hold until it's done, so don't convert them again.`,
  review: `We're checking this conversion. Your ${POINTS_WORD} stay on hold until it's done, so don't convert them again.`,
  /** Why a cancelled conversion ended, by cause. */
  cancelled: {
    refused: `We couldn't pay this into your wallet right now, so your ${POINTS_WORD} were given back. Try again in a moment.`,
    no_wallet: `We couldn't find your wallet to pay into, so your ${POINTS_WORD} were given back.`,
    failed: `The payment didn't go through, so your ${POINTS_WORD} were given back. Try again in a moment.`,
  },
} as const;
export type CancelReason = keyof typeof CONVERSION_WORDS.cancelled;

/** Words for the person on a conversion that was refused before anything was held. */
export const BELOW_MINIMUM_WORDS = `That's fewer ${POINTS_WORD} than you can convert at once.`;
export const CURRENCY_WORDS = `Turning ${POINTS_WORD} into cash isn't available for dollar accounts yet. Your ${POINTS_WORD} are safe.`;
export const TOO_MUCH_WORDS = `That's more than we can pay out at once. Try fewer ${POINTS_WORD}.`;
