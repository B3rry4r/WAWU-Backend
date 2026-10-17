import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import type { ActionUnit } from '../../plans/plans-config';

/**
 * What the spend routes answer (task POINTS-03, PT1 to PT3 and PT7). Points
 * are a count, never naira: a figure that carries points ends in `Points`, a
 * figure that carries money ends in `Kobo` or `Minor`.
 */

/** Which cap stops a job. */
export type PointsCapName = 'daily' | 'characters_per_job' | 'minutes_per_job';

/** A cap that stops a job, and when it stops (PT7). Nothing is held when one does. */
export interface PointsCapView {
  cap: PointsCapName;
  /** The cap's size, in `unit`. */
  limit: number;
  unit: 'points' | 'characters' | 'minutes';
  /** The daily cap: points of AI jobs held or spent since the day began; null for the others. */
  usedPoints: number | null;
  /** The daily cap: points still free today, 0 or more; null for the others. */
  remainingPoints: number | null;
  /** The daily cap: when the day's count starts again (ISO 8601); null for a cap that never resets. */
  resetsAt: string | null;
  /** In words the person reads. */
  message: string;
}

/**
 * The wallet money that would buy the shortfall (PT3), at the pack rate.
 * Nothing has been taken: it is bought only by `POST /points/shortfall` with
 * the PIN, sending back `payment.totalKobo` and `payment.quoteToken`.
 */
export interface PointsShortfallOfferView {
  currency: 'NGN';
  /** The points the money buys: exactly the shortfall. */
  points: number;
  /** What the points cost, in kobo (the provider's charge is on top, in `payment`). */
  priceKobo: number;
  /** The rate it is worked out at: kobo for a thousand points, from the settings. */
  per1000PointsKobo: number;
  /** The wallet payment's own quote: fee, total, balance, the signed token. */
  payment: PaymentQuoteView;
}

/** `POST /points/quote`: what a job costs, and whether it can run. Nothing is held or taken. */
export interface PointsQuoteView {
  action: string;
  /** The tool's name as a held job shows it ("VoiceOver"). */
  title: string;
  per: ActionUnit;
  units: number;
  /** Dubbing only; 1 otherwise. */
  languages: number;
  /** The plan's points for one unit. */
  perUnitPoints: number;
  /** The job's cost, from the settings. */
  costPoints: number;
  balancePoints: number;
  /** Points missing to run the job: 0 when the balance covers it. */
  shortfallPoints: number;
  /** The person's "Use wallet" choice (off until they turn it on). */
  useWallet: boolean;
  /** True when the balance covers the cost and no cap stops the job. */
  canRun: boolean;
  /** The cap that stops the job, or null. When one does, no wallet money is offered. */
  cap: PointsCapView | null;
  /**
   * With a shortfall and "Use wallet" on: the wallet money for the shortfall.
   * Null otherwise (no shortfall, "Use wallet" off, a cap, or `walletNote`).
   */
  wallet: PointsShortfallOfferView | null;
  /** Why the wallet money is not offered although "Use wallet" is on (no wallet yet, dollars, fees not set); else null. */
  walletNote: string | null;
}

export type PointsShortfallStatus = 'paid' | 'pending' | 'failed' | 'reversed';

/** `POST /points/shortfall` and the poll of it: the points bought with wallet money. */
export interface PointsShortfallView {
  /** The wallet payment's id. */
  id: string;
  currency: 'NGN';
  status: PointsShortfallStatus;
  statusMessage: string | null;
  points: number;
  /** The price, in kobo (the provider's charge is on top, in `payment`). */
  amountKobo: number;
  payment: PaymentView;
  /** The lot that was added, once the payment is confirmed. */
  grant: { points: number; expiresAt: string } | null;
  createdAt: string;
  paidAt: string | null;
}

/** `PUT /me/points/settings` and its read. */
export interface PointsSettingsView {
  useWallet: boolean;
}
