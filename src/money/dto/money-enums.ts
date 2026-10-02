/**
 * The closed sets of values the Naira wallet contract uses in requests
 * (task MONEY-04). Each is a const array so a DTO can validate against it and
 * the contract can list it as an enum; the matching type is derived from the
 * array, so the two cannot drift.
 */

/** What a fee quote is for (GET /money/fees/quote). Purchases are quoted by GET /money/payments/quote. */
export const FEE_QUOTE_KINDS = ['wawu_transfer', 'bank_transfer'] as const;
export type FeeQuoteKind = (typeof FEE_QUOTE_KINDS)[number];

/**
 * What a wallet payment is for, and the task that makes each one pay from
 * the wallet. The last three are held in WAWU's merchant wallet until their
 * release condition (R-19).
 *
 *   content_unlock  HOME-15     tip           HOME-14
 *   credit_pack     INBOX-16    verification  ME-18
 *   legal_fee       LEGAL-05    school_fee    SCHOOLS-07
 *   paid_dm         INBOX-17 (held)
 *   event_ticket    EVENTS-07 (held)
 *   bill            BILLS-04 (held)
 */
export const PAYMENT_KINDS = [
  'content_unlock',
  'tip',
  'credit_pack',
  'verification',
  'legal_fee',
  'school_fee',
  'paid_dm',
  'event_ticket',
  'bill',
] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** The only kind where the payer chooses the amount; every other price is the server's. */
export const PAYER_CHOSEN_AMOUNT_KINDS: readonly PaymentKind[] = ['tip'];

/** Kinds whose price is held until something happens (R-19). */
export const HELD_PAYMENT_KINDS: readonly PaymentKind[] = [
  'paid_dm',
  'event_ticket',
  'bill',
];

/** The filter chips on W26: All, Money in, Money out, Bills, Content. */
export const TRANSACTION_FILTERS = [
  'all',
  'money_in',
  'money_out',
  'bills',
  'content',
] as const;
export type TransactionFilter = (typeof TRANSACTION_FILTERS)[number];

/** Which side of a hold the caller is on. */
export const HOLD_ROLES = ['payer', 'payee'] as const;
export type HoldRole = (typeof HOLD_ROLES)[number];

export const BENEFICIARY_KINDS = ['wawu_user', 'bank_account'] as const;
export type BeneficiaryKind = (typeof BENEFICIARY_KINDS)[number];

/**
 * Every `reason.code` a money route can answer with. The HTTP status for
 * each is fixed in docs/contract/CONVENTIONS.md; a client switches on the
 * code, never on the message.
 */
export const MONEY_ERROR_CODES = [
  'wallet_not_open',
  'wallet_opening',
  'wallet_frozen',
  'provider_unreachable',
  'idempotency_key_required',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'pin_required',
  'pin_not_set',
  'pin_already_set',
  'pin_incorrect',
  'pin_locked',
  'pin_mismatch',
  'reset_code_invalid',
  'insufficient_funds',
  'daily_limit_exceeded',
  'amount_out_of_range',
  'quote_changed',
  'name_check_failed',
  'recipient_not_found',
  'recipient_has_no_wallet',
  'recipient_blocked',
  'self_transfer',
  'bank_transfers_blocked',
  'target_not_found',
  'target_not_payable',
  'not_found',
  // Open your wallet's identity step (KYC-01).
  'bvn_not_confirmed',
  'bvn_phone_mismatch',
  'phone_not_nigerian',
  'identity_checks_exhausted',
  'bvn_not_checked',
  'wallet_already_open',
] as const;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];
