/**
 * What the points-to-cash routes answer (task POINTS-04, PT6, R-43).
 *
 * Points are counts (`...Points`), money is integer kobo (`...Kobo`, R-21):
 * the two are never mixed in one field, and a figure here is never added up
 * into a balance (the wallet's is the provider's, MONEY-11).
 */

/** Why a quote cannot be converted as asked; null when it can. */
export type ConvertBlockedBy =
  | 'below_minimum'
  | 'insufficient_points'
  | 'above_maximum'
  /** More points than the person's earned and bonus points: points they bought cannot be cashed out (R-101). */
  | 'not_cashable';

/** `GET /points/convert/quote`: PT6 before the PIN. Nothing is held. */
export interface PointsConvertQuoteView {
  currency: 'NGN';
  /** The points the person has now, bought ones included. */
  balancePoints: number;
  /**
   * The points the person can turn into cash now: their earned and bonus
   * points that have not ended. Points they bought are in `balancePoints` and
   * never here (R-101 point 7). The quote is for all of these when no
   * `points` is asked.
   */
  cashablePoints: number;
  /** The fewest points one conversion takes (config, TIER-01). */
  minimumPoints: number;
  /** The most points one conversion takes, from the provider cap on one move; null with no cap. */
  maximumPoints: number | null;
  /** The rate, as the config quotes it: `rate.kobo` is paid for `rate.points` points. */
  rate: { points: number; kobo: number };
  /** The points this quote is for: the ones asked about, else all the cashable points. */
  points: number;
  /** The naira the person receives for `points`, in kobo, rounded down. */
  cashKobo: number;
  /** What the person pays to convert: nothing (R-31). */
  feeKobo: number;
  /** True: the provider's charge on the move is WAWU's (R-31). */
  wawuPaysProviderCharge: boolean;
  /** Whether `points` can be converted as they are. */
  canConvert: boolean;
  /** Why not, when `canConvert` is false. */
  blockedBy: ConvertBlockedBy | null;
  /**
   * Binds this quote to the conversion that follows: send it back as
   * `quoteToken` in `POST /points/convert`. Opaque to the app. The server
   * pays what this quote shows or nothing: if the rate, the minimum, the cap
   * or the cash changed since, the conversion is `409 quote_changed` with the
   * new quote (and a new token) in `reason.pointsQuote`, and no points move.
   */
  quoteToken: string;
  /** When the token stops being honoured (ISO 8601). */
  expiresAt: string;
}

/**
 * Where a conversion stands, for the person: `completed` (the cash is in the
 * wallet and the points are spent), `pending` (the points are on hold and the
 * cash is not confirmed yet: poll `GET /points/convert/{id}`), `failed` (the
 * cash did not move and the points are back).
 */
export type PointsConversionStatus = 'completed' | 'pending' | 'failed';

/** One conversion (`POST /points/convert`, `GET /points/convert/{id}`). */
export interface PointsConversionView {
  id: string;
  status: PointsConversionStatus;
  currency: 'NGN';
  points: number;
  /** The naira paid into the wallet, in kobo. */
  cashKobo: number;
  /** Our reference; the wallet's history row carries it. */
  reference: string;
  /** What to show beside a conversion that is not finished; null otherwise. */
  statusMessage: string | null;
  /** Why a `failed` conversion ended, in words; null on every other status. */
  failureReason: string | null;
  createdAt: string;
  /** When the cash was confirmed (completed) or the points went back (failed). */
  completedAt: string | null;
}
