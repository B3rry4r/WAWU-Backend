/**
 * Response shapes of the Naira wallet contract (task MONEY-04).
 *
 * Every shape here is a named interface on purpose: scripts/enrich-contract.js
 * turns a named, non-generic type into one components.schemas entry, so the
 * mobile client gets one `TransferView` rather than the same object inlined
 * at every route (BACKEND_GAPS G-1 in the mobile repo). A generic wrapper such
 * as `CursorPage<T>` would be inlined again, which is why each list has its
 * own page type below.
 *
 * Units, everywhere in this file (docs/contract/CONVENTIONS.md):
 * - money is an integer number of kobo, in a field whose name ends in `Kobo`;
 * - a time is an ISO 8601 UTC string;
 * - a phone number is E.164, `+234...`.
 */

import type {
  BeneficiaryKind,
  FeeQuoteKind,
  PaymentKind,
} from './dto/money-enums';

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

/**
 * What a money movement costs on top of its amount (R-10): the provider's
 * charge plus WAWU's fee, each from server config, never from the app or
 * the canvas. Either part can be 0. On a purchase WAWU's part is always 0,
 * because WAWU's share is the 85/15 split.
 */
export interface FeeBreakdown {
  /** Fintava's charge for this action (docs/fintava/fees.md in the mobile repo). */
  providerFeeKobo: number;
  /** WAWU's fee on top (R-10). 0 on purchases. */
  wawuFeeKobo: number;
  /** providerFeeKobo + wawuFeeKobo. */
  totalFeeKobo: number;
}

/** Someone on WAWU, as a money screen shows them. */
export interface MoneyPartyView {
  wawuUserId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  /** The tick shown beside the name (purple creator, blue professional). */
  tick: 'creator' | 'professional' | null;
}

/** A bank account outside WAWU, as a money screen shows it. */
export interface BankAccountView {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  /** The name the bank returned on the name check, never one the user typed. */
  accountName: string;
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */

/**
 * not_open: nobody has a wallet until they open one (R-6).
 * opening:  Open your wallet finished and the account is being created (A7).
 * open:     the account exists and can move money.
 * frozen:   the account exists and Fintava has it frozen (fraud hold or the
 *           30-day account deletion window, R-17).
 */
export type WalletState = 'not_open' | 'opening' | 'open' | 'frozen';

/** The account people pay into (W1, W5, W15, A8, W35 "Account details"). */
export interface WalletAccountView {
  /** NUBAN, 10 digits. */
  accountNumber: string;
  accountName: string;
  /** The bank name Fintava returned when the account opened (Loma Bank), never the canvas's. */
  bankName: string;
  bankCode: string;
  /** Licence wording from config, filled in by the owner (R-1). Null hides the line. */
  licenceLine: string | null;
  /** Deposit-insurance wording from config, filled in by the owner (R-1). Null hides the line. */
  depositInsuranceLine: string | null;
  openedAt: string;
}

/**
 * The daily send limit and what is left of it today (limits.md in the
 * mobile repo). The figures come from config per tier, marked provisional
 * there; `tier` is whatever Fintava reports, or null when it reports none.
 */
export interface WalletLimitsView {
  tier: string | null;
  dailyLimitKobo: number;
  usedTodayKobo: number;
  remainingTodayKobo: number;
  /** When today's limit starts again. The day boundary is Fintava's policy, read from config. */
  resetsAt: string;
}

/** The transaction PIN's state (W11, W35, W36, A9). The PIN itself never leaves the server. */
export interface PinStateView {
  isSet: boolean;
  /** When it was set or last changed (W35 "last changed"). Null when not set. */
  changedAt: string | null;
  /** Wrong tries left before it locks. MONEY-09 locks it after 5. */
  triesLeft: number;
  /** Set while locked; the PIN sheet shows when it ends. */
  lockedUntil: string | null;
}

/**
 * Why sending to a bank is refused for this person right now (W18).
 * Sending to WAWU users, bills and purchases are not affected by it.
 */
export type BankTransferBlock =
  'kyc_pending' | 'kyc_rejected' | 'kyc_not_submitted';

/** Whether this person may send to a bank account now (W17, W18). */
export interface BankTransferAccessView {
  allowed: boolean;
  /** Null when allowed. */
  blockedBy: BankTransferBlock | null;
}

/**
 * GET /money/wallet: our own record of the wallet. It never calls Fintava,
 * so it answers even when the bank does not (W6 keeps the bill tiles), and
 * it never carries a balance: that is GET /money/wallet/balance.
 */
export interface WalletView {
  state: WalletState;
  /** Null while state is not_open or opening. */
  account: WalletAccountView | null;
  /** Null when no limit is known; the screen hides the row (A8, W35). */
  limits: WalletLimitsView | null;
  pin: PinStateView;
  bankTransfers: BankTransferAccessView;
  beneficiaryCount: number;
}

/**
 * GET /money/wallet/balance: Fintava's figure, fetched on every call
 * (`availableBalance`). Never a sum of our own records.
 */
export interface WalletBalanceView {
  availableKobo: number;
  /** When Fintava answered. */
  asOf: string;
}

/* ------------------------------------------------------------------ */
/* PIN                                                                 */
/* ------------------------------------------------------------------ */

/** POST /money/pin/reset: a code was sent to the phone on file (W37). */
export interface PinResetView {
  resetId: string;
  /** The phone the code went to, masked: `+234 803 *** 4412`. */
  sentTo: string;
  /** When Resend becomes available (W37's countdown). */
  resendAvailableAt: string;
  expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* Banks, recipients, beneficiaries, payout account                    */
/* ------------------------------------------------------------------ */

/** One bank from Fintava's list. Keyed on `code`: some names repeat with different codes. */
export interface BankView {
  code: string;
  name: string;
}

/** POST /money/banks/name-check: the account holder's name, from the bank. */
export interface AccountNameView {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

/** A WAWU user who can be sent money (W7). Only people with an open wallet. */
export interface RecipientView {
  wawuUserId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  tick: 'creator' | 'professional' | null;
}

/** A saved place to send money (W8, W12 "Save as beneficiary", W35 count). */
export interface BeneficiaryView {
  id: string;
  kind: BeneficiaryKind;
  /** Set when kind is wawu_user. */
  wawuUser: MoneyPartyView | null;
  /** Set when kind is bank_account. */
  bankAccount: BankAccountView | null;
  createdAt: string;
}

/** The creator's own payout bank account (A21, W17's default destination). */
export interface PayoutAccountView {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  /**
   * Whether the bank's name for the account matches the name on the BVN.
   * Null when there is no BVN name to compare with.
   */
  matchesBvnName: boolean | null;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Fee quotes                                                          */
/* ------------------------------------------------------------------ */

/**
 * GET /money/fees/quote: what a send will cost before the PIN (W10, W17).
 * The send request repeats `totalKobo` as `expectedTotalKobo`; if the fee
 * changed in between, the send is refused with `quote_changed` and the new
 * quote, so the fee shown is always the fee charged.
 */
export interface FeeQuoteView {
  kind: FeeQuoteKind;
  /** What the recipient gets ("They get ₦25,000"). */
  amountKobo: number;
  fee: FeeBreakdown;
  /** amountKobo + fee.totalFeeKobo: what leaves the wallet, and what the button shows. */
  totalKobo: number;
  /** False when this send would pass today's limit (stopped before the PIN). */
  withinDailyLimit: boolean;
  /** What is left of today's limit; null when no limit is known. */
  remainingTodayKobo: number | null;
}

/* ------------------------------------------------------------------ */
/* Transfers                                                           */
/* ------------------------------------------------------------------ */

/**
 * pending:   accepted and debited; the bank has not confirmed (bank sends).
 * completed: the money arrived.
 * failed:    refused before any money left the wallet.
 * reversed:  the money left, the send failed, and it came back (W14).
 */
export type TransferStatus = 'pending' | 'completed' | 'failed' | 'reversed';

/** One step on W19's timeline. */
export interface TransferTimelineEntry {
  step: 'requested' | 'sent_to_bank' | 'completed' | 'failed' | 'reversed';
  at: string;
}

/**
 * What came back after a reversal (W14). Rule 6 of the designer brief: show
 * the amount actually returned, and a kept charge as its own row. Whether
 * Fintava returns its charge on a reversal is not confirmed yet, so both are
 * read from what Fintava actually reversed, never assumed.
 */
export interface TransferReversalView {
  returnedKobo: number;
  keptKobo: number;
  reversedAt: string;
}

/** A send to a WAWU user or to a bank (W12, W14, W19). */
export interface TransferView {
  id: string;
  kind: 'wawu_user' | 'bank_account';
  status: TransferStatus;
  /** What the recipient gets. */
  amountKobo: number;
  fee: FeeBreakdown;
  /** What left the wallet: amountKobo + fee.totalFeeKobo. */
  totalKobo: number;
  note: string | null;
  /** WAWU's reference for this send, shown on the receipt. Opaque: display it as given. */
  reference: string;
  /** Set when kind is wawu_user. */
  toWawuUser: MoneyPartyView | null;
  /** Set when kind is bank_account. */
  toBankAccount: BankAccountView | null;
  timeline: TransferTimelineEntry[];
  /** A sentence for the person, set when status is failed or reversed. */
  failureReason: string | null;
  reversal: TransferReversalView | null;
  createdAt: string;
  completedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Pay from wallet and holds                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /money/payments/quote: everything the pay sheet shows before the PIN
 * (H14, W10's "Pay from wallet" row, H17's shortfall).
 */
export interface PaymentQuoteView {
  kind: PaymentKind;
  targetId: string;
  /** What is being paid for, as the owning feature names it ("How I light a night shoot"). */
  title: string;
  /** Who gets the money; null when WAWU itself is paid (credits, ticks, bills). */
  payee: MoneyPartyView | null;
  /** The price, from the server's own record of the item, never from the app. */
  priceKobo: number;
  /** Provider charge only; wawuFeeKobo is 0 on purchases (R-10). */
  fee: FeeBreakdown;
  /** priceKobo + fee.totalFeeKobo: what the button and the PIN sheet show. */
  totalKobo: number;
  /** Fintava's available balance; null when the bank did not answer. */
  balanceKobo: number | null;
  /** totalKobo - balanceKobo when that is above 0, else 0; null when balanceKobo is null. */
  shortfallKobo: number | null;
  /** True when this kind is held until something happens (paid DM, ticket, bill). */
  willBeHeld: boolean;
  /**
   * False when this payment would pass today's limit; it is then stopped
   * before the PIN, as a send is (Lead ruling, 2 Oct 2026: a purchase debits
   * the buyer's wallet like a send). Whether Fintava counts purchases toward
   * the tier limit is still Fintava's to confirm.
   */
  withinDailyLimit: boolean;
  /** What is left of today's limit; null when no limit is known. */
  remainingTodayKobo: number | null;
}

export type HoldStatus = 'held' | 'released' | 'refunded';

/** What releases a hold to the payee; the opposite outcome refunds the payer. */
export type HoldReleaseCondition =
  'dm_answered' | 'event_took_place' | 'bill_delivered';

/**
 * Money held between payer and payee in WAWU's merchant wallet (R-19). The
 * price is held; the provider charge on the original payment is not part of
 * it and is not refunded (R-10: a refund returns the price).
 */
export interface HoldView {
  id: string;
  paymentId: string;
  kind: PaymentKind;
  status: HoldStatus;
  /** The held price. */
  amountKobo: number;
  releaseCondition: HoldReleaseCondition;
  payer: MoneyPartyView;
  /** Null when WAWU itself is the payee (a bill). */
  payee: MoneyPartyView | null;
  heldAt: string;
  /** When it was released or refunded. */
  settledAt: string | null;
  /** Set when refunded: what came back to the payer. */
  refundedKobo: number | null;
}

/** A page of holds, newest first. `nextCursor` null means the last page. */
export interface HoldPage {
  items: HoldView[];
  nextCursor: string | null;
}

/**
 * pending:   the debit is not confirmed yet (H18, E10); poll GET /money/payments/{id}.
 * completed: paid; the owning feature has granted what was bought.
 * failed:    refused before any money left the wallet.
 * reversed:  the debit came back (for example a biller failure, S12).
 */
export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export interface PaymentView {
  id: string;
  kind: PaymentKind;
  targetId: string;
  title: string;
  status: PaymentStatus;
  priceKobo: number;
  fee: FeeBreakdown;
  totalKobo: number;
  reference: string;
  /** Set for held kinds. */
  hold: HoldView | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** What a row is, for its icon and the filters. */
export type TransactionCategory =
  | 'transfer'
  | 'top_up'
  | 'earning'
  | 'purchase'
  | 'bill'
  | 'hold'
  | 'refund'
  | 'reversal';

/** The other side of a row (W26 avatar and name, W27 From/To). */
export interface TransactionCounterpartyView {
  kind: 'wawu_user' | 'bank_account' | 'biller' | 'wawu';
  name: string;
  avatarUrl: string | null;
  wawuUserId: string | null;
  bankName: string | null;
  /** Last 4 digits only. */
  accountNumberLast4: string | null;
}

/** What a row was for, when it was for something on WAWU (W27 "source content"). */
export interface TransactionLinkView {
  kind: PaymentKind;
  targetId: string;
  title: string;
}

/**
 * Several movements shown as one history row (W26: "Unlock · Lighting night
 * shoots · 3 buyers · +₦7,500.00"). Only unlock earnings of the same content
 * piece on the same Africa/Lagos day group; docs/contract/WALLET.md section 1
 * has the rule (Lead ruling, 2 Oct 2026; MONEY-15 builds it).
 */
export interface TransactionGroupView {
  /** Opaque. GET /money/transactions?group=<key> lists the movements in it, one per row. */
  key: string;
  /** How many movements the row stands for (W26's "3 buyers"). */
  count: number;
  /** The earliest and the latest movement in the group. The row's createdAt is lastAt. */
  firstAt: string;
  lastAt: string;
}

/**
 * One row of the wallet's history, from our ledger mirrored from Fintava
 * (MONEY-10). A row is never added up into a balance. A grouped row's
 * amounts are the sums of its movements and its `group` is set.
 */
export interface TransactionView {
  id: string;
  direction: 'in' | 'out';
  category: TransactionCategory;
  status: TransferStatus;
  /** What moved, before fees. */
  amountKobo: number;
  /** Fees on a money-out row; all zero on a money-in row. */
  fee: FeeBreakdown;
  /** Money out: what left the wallet (amount + fees). Money in: what arrived. */
  totalKobo: number;
  description: string;
  counterparty: TransactionCounterpartyView | null;
  link: TransactionLinkView | null;
  note: string | null;
  reference: string;
  /** Set when the row is a transfer or a payment, to open its own receipt. */
  transferId: string | null;
  paymentId: string | null;
  /** Set when the row stands for several movements (W26); null on an ordinary row. */
  group: TransactionGroupView | null;
  createdAt: string;
}

/** A page of history, newest first. `nextCursor` null means the last page. */
export interface TransactionPage {
  items: TransactionView[];
  nextCursor: string | null;
}

/** W26's "In · September / Out · September". Sums of that month's completed rows. */
export interface MonthlySummaryView {
  /** YYYY-MM, in Africa/Lagos time. */
  month: string;
  inKobo: number;
  outKobo: number;
}
