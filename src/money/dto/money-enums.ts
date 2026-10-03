/**
 * The closed sets of values the Naira wallet contract uses in requests
 * (task MONEY-04). Each is a const array so a DTO can validate against it and
 * the contract can list it as an enum; the matching type is derived from the
 * array, so the two cannot drift.
 */

/**
 * What a fee quote is for (GET /money/fees/quote, WALLET-15):
 *
 *   wawu_transfer  a send to another WAWU user (W10)
 *   bank_transfer  a send to a bank, or a withdrawal to the payout account (W10, W17)
 *   purchase       anything WAWU sells, paid from the wallet: an unlock, tip,
 *                  tick, ticket, paid DM, credits, a course, a legal service.
 *                  The pay sheet itself is GET /money/payments/quote (MONEY-17),
 *                  which takes its fee from the same schedule.
 *   bill           electricity, cable, airtime or data (`billCategory`)
 *
 * Card top-up and card order are added by WALLET-25 and WALLET-31.
 */
export const FEE_QUOTE_KINDS = [
  'wawu_transfer',
  'bank_transfer',
  'purchase',
  'bill',
] as const;
export type FeeQuoteKind = (typeof FEE_QUOTE_KINDS)[number];

/** What a bill pays for; Fintava charges by category (docs/fintava/fees.md in the mobile repo). */
export const BILL_CATEGORIES = [
  'electricity',
  'cable',
  'airtime',
  'data',
] as const;
export type BillCategory = (typeof BILL_CATEGORIES)[number];

/**
 * One line of a fee quote (FeeQuotePartView.code):
 *
 *   balance_transfer  Fintava's wallet to wallet charge, by amount band
 *   bank_transfer     Fintava's charge on a send to a bank
 *   bill_charge       Fintava's charge on a bill, by category
 *   wawu_fee          WAWU's own fee on top (R-10)
 */
export const FEE_PART_CODES = [
  'balance_transfer',
  'bank_transfer',
  'bill_charge',
  'wawu_fee',
] as const;
export type FeePartCode = (typeof FEE_PART_CODES)[number];

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

/** What a phone approves a payment with (R-26): whichever it has. */
export const APPROVAL_BIOMETRICS = ['fingerprint', 'face'] as const;
export type ApprovalBiometricKind = (typeof APPROVAL_BIOMETRICS)[number];

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
  // Saved beneficiaries (WALLET-14).
  'beneficiary_limit_reached',
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
  // The selfie match to the BVN photo (KYC-02).
  'selfie_not_matched',
  'selfie_checks_exhausted',
  'selfie_already_matched',
  // Opening the account at Fintava (MONEY-12).
  'selfie_required',
  'identity_has_wallet',
  'account_not_opened',
  'phone_held_by_other_identity',
  // Resetting the PIN by a code, and approving with a fingerprint or face (MONEY-14).
  'reset_codes_exhausted',
  'device_approval_refused',
  // Statements (WALLET-27).
  'statement_too_large',
] as const;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];
