import { HELD_PAYMENT_KINDS } from '../dto/money-enums';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';

/**
 * The rules of an earning's landing that need no database (task WALLET-16,
 * R-11).
 *
 * An ordinary sale (not a held kind) is paid into WAWU's own account at the
 * wallet provider; the payee's 85% then has to move into the payee's wallet.
 * `EarningSettlement` is that move, one row per sale. The machinery is the
 * hold's release (MONEY-18) with nothing to decide: the sale is the decision.
 */

/** Where an earning stands: owed until the provider confirmed the move. */
export const EARNING_STATUSES = ['owed', 'landed'] as const;
export type EarningStatus = (typeof EARNING_STATUSES)[number];

/**
 * Why nothing has moved yet:
 * - `payee_wallet`: the person has no wallet yet (R-11: they keep earning).
 *   Looked at again after a rest that doubles with the earning's age, a minute
 *   to an hour, and at once in the first sweep after the wallet exists.
 * - `recipient_frozen`: the provider refuses a move into a frozen wallet
 *   (BACKEND_GAPS G-10): paid on unfreeze, tried hourly.
 * - `funds`: the provider says WAWU's own account cannot cover the move.
 * - `provider`: the provider is out of reach or not set up, or the sale is
 *   another provider's.
 * - `not_supported`: the running provider has no way to make this move yet
 *   (a Nuvion adapter without its book transfers). Logged as an error on every
 *   try; the earning waits and lands once the provider can.
 * - `refused`: the provider refused and nothing moved; a person looks past the
 *   review bound.
 */
export const EARNING_WAITING = [
  'payee_wallet',
  'recipient_frozen',
  'funds',
  'provider',
  'not_supported',
  'refused',
] as const;
export type EarningWaiting = (typeof EARNING_WAITING)[number];

/**
 * Where a settlement stands, as a caller is told:
 * - `landed`: the provider confirmed the move;
 * - `pending`: handed to the provider, not confirmed yet (a lost answer, or a
 *   transfer it accepted and has not finished); never sent again;
 * - `waiting`: nothing has moved; `waiting` says why;
 * - `review`: a person has to look.
 */
export type EarningSettlementState =
  'landed' | 'pending' | 'waiting' | 'review';

export interface EarningSettlementResult {
  settlementId: string;
  paymentId: string;
  state: EarningSettlementState;
  waiting: EarningWaiting | null;
  status: EarningStatus;
}

/** Where a pass of the sweep stopped, in the order (createdAt, id). */
export interface EarningSweepCursor {
  at: Date;
  id: string;
}

/**
 * How long one pass of the sweep may keep reading pages, as the hold sweep's
 * budget (MONEY-18 round 2, F4): a pass reads every due earning by a keyset
 * cursor with no cap on the rows it looks at, stops only at the end or when
 * this much time is used, and hands the place it reached to the next pass.
 */
export const EARNING_SWEEP_BUDGET_MS = 45_000;

/** Earnings the sweep reads at a time, and sales it adopts at a time. */
export const EARNING_SWEEP_PAGE = 50;
export const EARNING_ADOPT_PAGE = 200;
/** Adoption pages per pass: a backlog is taken over a few passes, never one long lock. */
export const EARNING_ADOPT_MAX_PAGES = 10;

/**
 * Our reference at the provider for one try of one earning. The first try is
 * `wawu-earn-<payment id>` (46 characters, inside Nuvion's 64
 * `unique_reference`); a later try, after the provider's own record proved
 * the earlier one failed, adds its number. The payment id names the earning,
 * so one sale has one reference however many callers drive it.
 */
export function earningReference(paymentId: string, attempt: number): string {
  const base = `wawu-earn-${paymentId}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** What the provider sees on the move. Names nobody and nothing personal. */
export { RELEASE_NARRATION as EARNING_NARRATION } from '../holds/hold-rules';

/** The kinds whose price is held: their share lands by the hold's release, never here. */
export const NOT_SETTLED_HERE: readonly string[] = HELD_PAYMENT_KINDS;

/**
 * What a refusal that moved nothing means for the earning: the reason it
 * waits. The same reading as the hold's (MONEY-18), plus `not_supported`,
 * which says so instead of hiding among "the provider".
 */
export function waitingAfterRefusal(refusal: WalletProviderError): {
  waiting: EarningWaiting;
  /** True when WAWU's own account is the problem or the provider refused outright: an error in the log. */
  loud: boolean;
} {
  if (refusal.requestNotSent) return { waiting: 'provider', loud: false };
  if (refusal instanceof WalletProviderLimitError) {
    return { waiting: 'provider', loud: false };
  }
  switch (refusal.kind) {
    case 'insufficient_funds':
      return { waiting: 'funds', loud: true };
    case 'wallet_inactive':
      return { waiting: 'recipient_frozen', loud: false };
    case 'not_supported':
      return { waiting: 'not_supported', loud: true };
    case 'auth':
    case 'not_configured':
    case 'merchant_inactive':
    case 'rate_limited':
    case 'unavailable':
    case 'bad_response':
      return { waiting: 'provider', loud: false };
    default:
      return { waiting: 'refused', loud: true };
  }
}
