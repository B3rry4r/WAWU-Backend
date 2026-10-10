import type { PaymentKind } from '../dto/money-enums';
import type {
  HoldReleaseCondition,
  HoldStatus,
} from '../money-view.type';

/**
 * The rules of a hold that need no database (task MONEY-18, R-19).
 *
 * A held kind (a paid DM, an event ticket, a bill) is paid into WAWU's own
 * account at the wallet provider, and the price waits there until something
 * happens. What releases it is fixed by the kind, so a feature never says
 * it: a paid DM when the creator answers, a ticket when the event takes
 * place, a bill when the biller delivers. The opposite outcome refunds the
 * payer (no answer in time, an event called off, a biller failure); which
 * outcome happened is the owning feature's to know and to ask for.
 */
export const HOLD_RELEASE_CONDITIONS: Readonly<
  Partial<Record<PaymentKind, HoldReleaseCondition>>
> = {
  paid_dm: 'dm_answered',
  event_ticket: 'event_took_place',
  bill: 'bill_delivered',
};

/** The release condition of a held kind; null for a kind that is not held. */
export function releaseConditionOf(
  kind: PaymentKind | string,
): HoldReleaseCondition | null {
  return (
    (HOLD_RELEASE_CONDITIONS as Record<string, HoldReleaseCondition>)[kind] ??
    null
  );
}

/** What an owning feature asks for. */
export type HoldAction = 'release' | 'refund';

/**
 * Why nothing has moved yet, when a settlement is waiting:
 * - `payee_wallet`, `payer_wallet`: the person has no wallet (yet). The
 *   money waits in WAWU's account and lands within a minute of the wallet
 *   opening (R-11); tried every minute, no back-off.
 * - `recipient_frozen`: the provider refuses a move into or out of a frozen
 *   wallet (BACKEND_GAPS G-10): paid on unfreeze, tried hourly.
 * - `funds`: the provider says WAWU's own account cannot cover the move.
 *   Held money is not where it should be: logged as an error every try.
 * - `provider`: the provider could not be reached or is not set up.
 * - `refused`: the provider refused the move and nothing moved; a person
 *   looks past the review bound.
 */
export const HOLD_WAITING = [
  'payee_wallet',
  'payer_wallet',
  'recipient_frozen',
  'funds',
  'provider',
  'refused',
] as const;
export type HoldWaiting = (typeof HOLD_WAITING)[number];

/** Waiting for a person's wallet: tried every minute, with no back-off. */
export const WALLET_WAITS: readonly HoldWaiting[] = [
  'payee_wallet',
  'payer_wallet',
];

/**
 * Where a settlement stands, as the owning feature is told:
 * - `settled`: the provider confirmed the move; the hold is released or refunded;
 * - `pending`: handed to the provider, not confirmed yet (a lost answer, or a
 *   transfer it accepted and has not finished); the sweep settles it and it
 *   is never sent again;
 * - `waiting`: nothing has moved; `waiting` says why and the sweep tries again;
 * - `review`: a person has to look.
 */
export type HoldSettlementState = 'settled' | 'pending' | 'waiting' | 'review';

export interface HoldSettlement {
  holdId: string;
  paymentId: string;
  action: HoldAction;
  state: HoldSettlementState;
  waiting: HoldWaiting | null;
  /** What a person sees: `held` until the provider has confirmed the move. */
  status: HoldStatus;
}

/** What a feature may ask a hold for. */
export type HoldRef = { paymentId: string } | { holdId: string };

export type HoldRequestErrorCode =
  /** No such hold: the payment is not a completed held payment. */
  | 'no_such_hold'
  /** The other outcome was already chosen: a hold is settled once, one way. */
  | 'other_action_chosen';

/** A request to release or refund that cannot be honoured. Not an HTTP answer: the feature decides what to do. */
export class HoldRequestError extends Error {
  constructor(
    readonly code: HoldRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HoldRequestError';
  }
}

/**
 * Our reference at the provider for one try of one move. A first try is
 * `wawu-rel-<hold id>` or `wawu-ref-<hold id>` (45 characters, inside
 * Nuvion's 64 for `unique_reference`); a later try, after the provider's own
 * record proved the earlier one failed, adds its number.
 */
export function holdReference(
  action: HoldAction,
  holdId: string,
  attempt: number,
): string {
  const base = `${action === 'release' ? 'wawu-rel' : 'wawu-ref'}-${holdId}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** What the provider sees on the move. Names nobody and nothing personal. */
export const RELEASE_NARRATION = 'WAWU earning';
export const REFUND_NARRATION = 'WAWU refund';

/** What a hold's action moves out of WAWU's account, in kobo. */
export function transferFor(
  action: HoldAction,
  hold: { amountKobo: bigint; payeeShareKobo: bigint },
): bigint {
  // A release moves the payee's 85% (R-5); the 15% is WAWU's and stays. A
  // refund returns the price, never the provider's charge on the original
  // payment (R-10).
  return action === 'release' ? hold.payeeShareKobo : hold.amountKobo;
}
