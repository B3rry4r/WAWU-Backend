/**
 * The rules of paying a creator's store earning that need no database
 * (STORE-PAYOUT, R-101 point 4).
 *
 * The owner, 27 Oct 2026: "Paying the users would be from our own pocket our
 * own nuvion wallet in 3 working days." A creator keeps exactly 85% of the list
 * price (`creatorShareOfList`); WAWU pays it out of its own account at the
 * wallet provider once `availableAt` has passed, and is repaid when Apple or
 * Google pay.
 */

/** Why a pending payout has not moved money yet. */
export type PayoutWaiting =
  'recipient_frozen' | 'funds' | 'provider' | 'refused' | 'payee_wallet';

/** What the provider sees on the transfer. Names nobody and nothing personal. */
export const PAYOUT_NARRATION = 'WAWU store sale';

/** One pass of the sweep stops reading when this much time is used. */
export const PAYOUT_SWEEP_BUDGET_MS = 45_000;

/** Due earnings read in one page. */
export const PAYOUT_PAGE = 100;

/** A payout that is refused or unanswered this long goes to a person. */
export const PAYOUT_REVIEW_AFTER_HOURS = 72;

const MINUTE = 60_000;

/** The rest before the next try or question: 1, 2, 4 ... minutes, at most an hour. */
export function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/**
 * Our reference at the provider for one try of one earning's payout:
 * `wawu-spay-<earning id>`, 46 characters, inside Nuvion's 64. It names the
 * earning, so any server builds the same one and the provider sees the payout
 * once; a later try, after the provider's own record proved the earlier one
 * failed, adds its number.
 */
export function payoutReference(
  storeEarningId: string,
  attempt: number,
): string {
  const base = `wawu-spay-${storeEarningId}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** A deduction with something still owed on it, as the planner reads it (oldest first). */
export interface OpenDeduction {
  id: string;
  owedKobo: bigint;
}

/** What netting an earning against the creator's open deductions comes to. */
export interface Netting {
  /** What each deduction takes of this earning. */
  takes: Array<{ deductionId: string; kobo: bigint }>;
  deductedKobo: bigint;
  /** What is sent: the share less the takes, never below 0. */
  netKobo: bigint;
}

/**
 * Takes the creator's open deductions from an earning, oldest first, never
 * more than the earning (the net is never below 0): what a deduction still owes
 * after that stays owed and comes out of the next earning or daily move.
 * `open` must already be oldest first.
 */
export function netAgainstDeductions(
  grossKobo: bigint,
  open: readonly OpenDeduction[],
): Netting {
  const takes: Netting['takes'] = [];
  let left = grossKobo;
  for (const d of open) {
    if (left <= 0n) break;
    if (d.owedKobo <= 0n) continue;
    const kobo = d.owedKobo < left ? d.owedKobo : left;
    takes.push({ deductionId: d.id, kobo });
    left -= kobo;
  }
  const deductedKobo = grossKobo - left;
  return { takes, deductedKobo, netKobo: left };
}

/** The Africa/Lagos calendar day of an instant, `YYYY-MM-DD` (Lagos has no summer time). */
export function lagosDayKey(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);
}
