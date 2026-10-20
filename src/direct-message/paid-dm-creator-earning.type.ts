/**
 * The creator's earning on one paid question (INBOX-18). Its own file so the
 * contract writes a field that can be null with the 3.0 form that keeps the
 * null (scripts/enrich-contract.js, NULLABLE_TARGET_AS_ALLOF_DIRS).
 */

/**
 * Where the creator's share of a question is (INBOX-18; I10, I11). The Hub's
 * figure and words, never worked out by the app (R-5, R-21).
 * - `pending`: not answered yet; answering earns `amountKobo`.
 * - `on_its_way`: answered; the share is an earning that reaches the wallet in
 *   the creator's one move a day (R-55).
 * - `waiting_for_wallet`: answered; the creator has no wallet yet, so the share
 *   waits and lands the moment they open one (R-11).
 * - `in_wallet`: answered; the share has landed in the wallet.
 */
export type PaidDmEarningState =
  'pending' | 'on_its_way' | 'waiting_for_wallet' | 'in_wallet';

export interface PaidDmCreatorEarning {
  /** The creator's share of the price, in kobo (the held price's payee share). */
  amountKobo: number;
  /** That share as a whole percent of the price (R-5: 85). */
  sharePct: number;
  state: PaidDmEarningState;
}
