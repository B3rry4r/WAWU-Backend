/**
 * What `GET /me/points` answers (task POINTS-01, PT5). Every figure is a
 * count of points: never naira, never dollars, and nothing here converts one
 * into the other.
 */

/** Where a lot came from (PointLotSource). */
export type PointLotSourceName =
  'tier_bonus' | 'pack' | 'bump' | 'referral' | 'shortfall' | 'returned';

/** Why a ledger row moved points (PointLedgerReason). */
export type PointMovementReason = 'grant' | 'hold' | 'release' | 'expire';

/** One lot that still has points and has not ended. */
export interface PointLotView {
  id: string;
  /** Points still in the lot. */
  points: number;
  /** Points the lot was granted with. */
  granted: number;
  source: PointLotSourceName;
  /** Where the points came from, in plain words ("Tier bonus"). */
  label: string;
  /** When what is left of the lot ends (ISO 8601, UTC). */
  expiresAt: string;
}

/** The soonest points to end: every live lot that ends at that moment. */
export interface PointNextExpiryView {
  points: number;
  expiresAt: string;
}

/** One ledger row: one change to one lot's points. */
export interface PointMovementView {
  id: string;
  /** Points added (above zero) or taken (below zero). */
  points: number;
  /** What moved them, in plain words ("Spent on VoiceOver", "Expired"). */
  label: string;
  reason: PointMovementReason;
  /** A hold row whose job has not ended yet; false on every other row. */
  pending: boolean;
  /**
   * When the row was written (ISO 8601, UTC). Named `createdAt`, not the
   * ledger's `at`: the contract builder drops a field named like an Array
   * method.
   */
  createdAt: string;
}

export interface MyPointsView {
  /** Points the caller can spend now: every live lot, whether listed or not. */
  balance: number;
  /** The soonest points to end, or null with no live lot. */
  nextExpiry: PointNextExpiryView | null;
  /** Live lots, soonest-expiring first (the order they are spent in). */
  lots: PointLotView[];
  /** How many live lots there are; `lots` lists the first POINTS_VIEW.lots. */
  lotCount: number;
  /** The last 20 ledger rows, newest first. */
  movements: PointMovementView[];
}
