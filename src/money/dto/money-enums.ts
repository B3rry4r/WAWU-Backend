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
 *   legal_fee       LEGAL-05    school_fee    SCHOOLS-07 (held)
 *   paid_dm         INBOX-17 (held)
 *   event_ticket    EVENTS-07 (held)
 *   bill            BILLS-04 (held)
 *
 * `tier` and `tier_bump` (TIER-03) are WAWU's own sale of a maker tier: a
 * tier bought, renewed or upgraded (`tier`), and the same with the checkout
 * offer's extra points (`tier_bump`). They are paid in one debit into WAWU's
 * own account with no seller split, and are not held. Their `targetId` names
 * the terms (docs/contract/PLANS.md section 8).
 *
 * `points_pack` (POINTS-02) is WAWU's own sale of a points pack (PT4): one
 * debit into WAWU's own account with no seller split, not held. Its `targetId`
 * is `pack-<packId>` (docs/contract/PLANS.md section 10).
 *
 * `extra_products` (TIER-04) is WAWU's own sale of more product places on the
 * tier a person holds (VF13): one debit into WAWU's own account with no seller
 * split, not held. Its `targetId` is `extra-products` (docs/contract/PLANS.md
 * section 11).
 *
 * `points_shortfall` (POINTS-03) is WAWU's own sale of the points an AI job is
 * short of (PT3), bought from the wallet at the pack rate on the person's
 * confirmation: one debit into WAWU's own account with no seller split, not
 * held. Its `targetId` is `shortfall-<points>` (docs/contract/CONVENTIONS.md
 * section 16a).
 *
 * `community_pass` (INBOX-24, R-63) is 30 days in a private community, bought
 * from the wallet with the PIN. Its `targetId` is the community's id. The host
 * is the payee (85%, R-5); it is not held: the host's share is an earning
 * like any sale, paid in their one move a day (R-55), and a pass that cannot
 * be granted is paid back in full, the charge included.
 *
 * `points_cash_out` (POINTS-04) is not a payment anyone makes from the wallet:
 * it is the link kind of the ledger rows of points turned into cash, WAWU's
 * own movement from its account into the person's wallet (R-43, R-31). It is
 * never registered with PayableRegistry, so a payment for it is
 * `target_not_payable` like any kind no feature has moved onto the wallet.
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
  'tier',
  'tier_bump',
  'points_pack',
  'extra_products',
  'points_shortfall',
  'points_cash_out',
  'community_pass',
] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** The only kind where the payer chooses the amount; every other price is the server's. */
export const PAYER_CHOSEN_AMOUNT_KINDS: readonly PaymentKind[] = ['tip'];

/** Kinds whose price is held until something happens (R-19). */
export const HELD_PAYMENT_KINDS: readonly PaymentKind[] = [
  'paid_dm',
  'event_ticket',
  'bill',
  'school_fee',
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
  'pin_changed_again',
  'reset_code_invalid',
  'insufficient_funds',
  'daily_limit_exceeded',
  'amount_out_of_range',
  'quote_changed',
  'name_check_failed',
  // A saved bank account whose holder's name at the bank is no longer the one kept (WALLET-09).
  'account_name_changed',
  // A payout account, or a withdrawal to one, whose holder at the bank is not
  // the person's verified name (WALLET-37, R-51); and the 30-an-hour limit on
  // bank name checks, per person (WALLET-37, R-51).
  'account_not_in_your_name',
  'name_check_rate_limited',
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
  // Pay from wallet (MONEY-17): one open payment per buyer and item.
  'payment_in_progress',
  // Statements (WALLET-27).
  'statement_too_large',
  'statement_rate_limited',
  'statement_busy',
  // Emailing a statement (WALLET-35).
  'email_not_verified',
  'statement_email_failed',
  // Finding a recipient (WALLET-08).
  'recipient_search_rate_limited',
  // Fees and limits as settings (NUV-07): the running provider's fees are
  // not set, so nothing is quoted or moved (R-42); a movement passes a limit.
  'fees_not_set',
  'limit_reached',
  // Opening a wallet on Nuvion (NUV-02): the person's details are with the
  // provider's compliance review; they wait, and nothing is sent again.
  'identity_under_review',
  // A step Open your wallet used under Fintava that a provider reviewing
  // the person itself does not have (NUV-02 round 2, U3): permanent, not
  // "try again".
  'step_not_used',
  // Opening tries from one address in an hour (NUV-02 round 3): a plain 429
  // with its own code, beside the person's `identity_checks_exhausted`.
  'open_address_limited',
  // Converting points to cash (POINTS-04): fewer points than the config's
  // minimum; more points than the person has; a person billed in dollars,
  // who has no dollar wallet to be paid into yet (NUV-09).
  'below_minimum',
  'insufficient_points',
  'currency_not_supported',
  // Buying event tickets (EVENTS-13): the buyer already holds the most open
  // paid ticket orders one event allows (an admin setting).
  'event_order_limit',
  // Paying a question from the wallet (INBOX-17, G-75): the fan already has a
  // question waiting on this creator, so another is not taken until it is answered or refunded.
  'question_already_waiting',
  // Spending points on AI tools (POINTS-03): a cap stops the job; the person
  // has enough points, so there is no shortfall to buy.
  'points_cap_reached',
  'points_not_short',
  // Adding products needs a tier that is running (TIER-04, VF13): the person
  // has none, or it ended. Also the code of the publishing gate (TIER-02), in
  // its own richer body on the routes that publish.
  'tier_required',
  // The pack of extra products is not sold to this person: their tier may not
  // buy it, or they hold the most packs a profile can (PACK-CAP, R-100).
  'pack_not_allowed',
  // Adding money by card, Apple Pay, USSD or a bank checkout (WALLET-25, WALLET-26):
  // the way asked for is switched off, or the provider has not switched it on.
  'add_money_unavailable',
  // Foreign-currency accounts, swaps and crypto sends (WALLET-21, R-83, R-84):
  // an admin switch is off for the currency or the product; a quote's real
  // expiry has passed (or it was used); the account is frozen by an admin; an
  // outside address does not suit its chain; the account's chain is not the
  // send's; the provider refused the move in its own words; the person has no
  // such account.
  'fx_switched_off',
  'quote_expired',
  'account_frozen',
  'address_invalid',
  'chain_mismatch',
  'provider_declined',
  'fx_account_not_open',
  // Sending abroad (NUV-11, R-84): the provider does not pay that country or
  // way; it refused the recipient's details (the fields it names are in
  // `fields`); it has no rate for the pair right now; an admin cannot cancel a
  // send the provider already holds.
  'corridor_not_supported',
  'recipient_details_invalid',
  'rate_unavailable',
  'send_not_cancellable',
  // A wallet for a person outside Nigeria (WALLET-41, R-87): the admin switch
  // is off; the day's cap on new openings is reached; no opening is taken
  // from the person's country.
  'world_switched_off',
  'world_limit_reached',
  'country_not_supported',
  // WALLET-41 round 1: the account's stored country of residence decides which opening is allowed.
  'residence_not_set',
  'residence_mismatch',
  // WALLET-41 round 3: a passport names the country that issued it.
  'passport_country_required',
  // Capital (NUV-12, R-84): switched off or not offered by the wallet
  // provider, or an order an admin has put on hold; a reservation that ran
  // out of time; a holding the provider will not pay out now.
  'capital_unavailable',
  'reservation_expired',
  'withdrawal_not_available',
  // WALLET-31 (R-84): the WAWU card.
  'cards_unavailable',
  'card_limit_reached',
  'card_blocked',
  'card_reveal_rate_limited',
] as const;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];
