/**
 * The rules of a paid question paid from the wallet that need no database
 * (task INBOX-17, R-10, R-19).
 */

/** The payment kind this feature sells (docs/contract/WALLET.md). */
export const PAID_DM_KIND = 'paid_dm' as const;

/** The route a paid question's Idempotency-Key is scoped to. */
export const PAID_DM_PAY_ROUTE = 'POST dm/send/wallet/pay';

/** The reference a wallet question's `DirectMessage` row carries in place of a Flutterwave charge's (the column is required and unique). */
export const WALLET_TX_REF_PREFIX = 'wallet:';
export const walletDmTxRef = (paymentId: string) =>
  `${WALLET_TX_REF_PREFIX}${paymentId}`;
export const isWalletDmTxRef = (ref: string) =>
  ref.startsWith(WALLET_TX_REF_PREFIX);
/** The payment a wallet question's reference names, or null for any other reference. */
export function paymentIdOfTxRef(ref: string): string | null {
  return isWalletDmTxRef(ref) ? ref.slice(WALLET_TX_REF_PREFIX.length) : null;
}

/** The longest question, as the web's `SendDmDto` allows. */
export const MAX_QUESTION_LENGTH = 2000;

export const KOBO_PER_NAIRA = 100;

/** An abandoned draft (no payment ever made for it) is removed after this long. */
export const DRAFT_KEEP_DAYS = 14;

export const QUESTION_NOT_FOUND = 'We could not find that question.';
export const CREATOR_NOT_FOUND = 'We could not find that creator.';
export const NOT_ACCEPTING = 'This creator has not switched on paid messages.';
export const PAUSED_MESSAGE =
  'This creator has switched off paid messages for now.';
export const BLOCKED_MESSAGE =
  'You cannot send a paid message to this account.';
export const OWN_QUESTION = 'You cannot ask yourself a paid question.';
export const ALREADY_WAITING = 'You can send once they reply.';
export const ALREADY_SENT = 'This question has already been sent.';
export const KEY_REUSED =
  'That Idempotency-Key was already used for a different question.';
export const KEY_MALFORMED =
  'Idempotency-Key must be 8 to 128 letters, digits, dashes or underscores.';
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** The hold's `releaseCondition` for a question that could not be delivered and is being paid back. */
export const UNDELIVERED_CONDITION = 'dm_not_delivered';

/** Why a hold was settled, as the hold's note (never shown to a person). */
export const UNDELIVERED_REASON = 'the question could not be delivered';
export const UNANSWERED_REASON = 'no reply in time';
export const ANSWERED_REASON = 'the creator answered';

/** What the app reads of a wallet question (docs/contract/WALLET.md, "Paid questions from the wallet"). */
export type PaidQuestionStatus =
  /** Drafted and priced; no payment made. */
  | 'unpaid'
  /** The payment is confirming, or it is confirmed and the question is being sent. */
  | 'pending'
  /** Sent; the creator has until `deadlineAt` to reply. The price is held by WAWU. */
  | 'asked'
  /** The creator replied; their share is on its way to their wallet (R-11). */
  | 'answered'
  /** No reply in time, or it could not be sent: the price is on its way back. */
  | 'refunding'
  /** The price is back in the payer's wallet. */
  | 'refunded'
  /** The provider refused the payment; nothing moved. */
  | 'failed'
  /** The payment was reversed by the provider. */
  | 'reversed';

/** The deadline a question sent at `sentAt` gives its creator. */
export function deadlineOf(sentAt: Date, responseWindowHours: number): Date {
  return new Date(sentAt.getTime() + responseWindowHours * 3_600_000);
}
