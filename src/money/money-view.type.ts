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
  ApprovalBiometricKind,
  BeneficiaryKind,
  BillCategory,
  FeePartCode,
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
 * The daily limit the wallet provider puts on the account, what was moved
 * today and what is left (W35; task WALLET-23, `AccountLimits`). The limit is
 * the provider's: Fintava reports the wallet's tier on every balance read and
 * the tier's daily limit is a setting (limits.md in the mobile repo). `tier`
 * is always null: the limits row names no tier (BRIEF W35), and the provider's
 * own name for the level stays on the wallet row for ops.
 */
export interface WalletLimitsView {
  tier: string | null;
  dailyLimitKobo: number;
  usedTodayKobo: number;
  remainingTodayKobo: number;
  /** When today's limit starts again: the next midnight in Lagos, where WAWU's own daily limits also turn over. */
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
  /** Null until a balance read has kept the provider's limit, and when it names none; the screen hides the row (A8, W35). */
  limits: WalletLimitsView | null;
  pin: PinStateView;
  bankTransfers: BankTransferAccessView;
  beneficiaryCount: number;
  /**
   * Where the account number stands (W1, W15, A7; NUV-04): `active` once
   * there is an account to pay into (`account` is filled); `on_its_way`
   * while it is being opened or, at a provider that issues the number
   * later (Nuvion), after approval until the number is active; `none`
   * otherwise. `account` is never filled before `active`.
   */
  accountNumberStatus: WalletAccountNumberStatus;
  /**
   * Which Open your wallet this server runs (NUV-02, additive; sent only
   * under a provider that reviews the person, so absent means `check`): `check`, the
   * BVN check and selfie match, then the account (Fintava, MONEY-12);
   * `review`, the details with the BVN and NIN sent once for the provider's
   * own review, then the ID document and proof of address (Nuvion, NUV-02
   * and NUV-03).
   */
  openingFlow?: WalletOpeningFlow;
  /**
   * Where the provider's review of the person stands (NUV-02, additive;
   * sent only with `openingFlow` `review`): null when nothing was sent yet. It never changes
   * what `state` means: `not_open` while documents are needed, after a
   * refusal, or when the review was stopped; `opening` while it is checked
   * and once approved, until the account number arrives (NUV-04).
   */
  review?: WalletReviewView | null;
  /**
   * FIX-109, additive: what a bank transfer into the wallet account costs and
   * how long it takes (W15's "Free" and its arrival line, W45's wait line).
   * Absent when the Hub knows neither; each field is absent when unknown, so
   * the screen draws a line only for what the Hub says. `feeKobo` 0 is free.
   */
  transferIn?: TransferInView;
}

/** `WalletView.transferIn`: what a transfer into the wallet account costs and how long it takes. */
export interface TransferInView {
  /**
   * What the provider charges on money arriving by bank transfer, in kobo
   * (0 is free). Absent when the provider names none, or when the charge
   * depends on the amount: no single figure says it.
   */
  feeKobo?: number;
  /** Minutes a transfer in usually takes to land (MONEY_ARRIVAL_BANK_IN_MINUTES). Absent when unset. */
  arrivalMinutes?: number;
}

/** Which Open your wallet a server runs (NUV-02). */
export type WalletOpeningFlow = 'check' | 'review';

/**
 * needs_documents: the details are in; the ID document and proof of address
 *                  are still needed (NUV-03), also after corrected details.
 * checking:        sent for review; the decision is on its way.
 * approved:        approved; the account number is on its way (NUV-04).
 * rejected:        the review said no: `reasons` say why and what to fix,
 *                  and the details may be sent again.
 * stopped:         the review failed for good or was suspended, or the BVN
 *                  it reviewed is another account's now: money routes
 *                  answer `wallet_not_open`; support can help.
 * expired:         the opening sat unfinished for too long (or support
 *                  closed it) and its BVN was let go; the person was told
 *                  and may send their details again to start a new one
 *                  (NUV-02 round 3).
 */
export type WalletReviewStage =
  | 'needs_documents'
  | 'checking'
  | 'approved'
  | 'rejected'
  | 'stopped'
  | 'expired';

/** Why a review said no, in plain words, and what to fix (NUV-02). */
export interface WalletReviewReasonView {
  code: WalletReviewReasonCode;
  /** What went wrong, a plain sentence the app may show. */
  message: string;
  /** What to do about it, a plain sentence the app may show. */
  fix: string;
}

/**
 * bvn_not_verified / nin_not_verified: that number could not be confirmed.
 * id_document_not_verified / proof_of_address_not_verified: that document.
 * bvn_phone_mismatch: the provider named the phone as not the BVN's (A14).
 * details_not_verified: the provider gave no reason we can name.
 * review_stopped: the review failed for good or was suspended.
 * review_expired: the opening was left unfinished too long and was closed.
 */
export type WalletReviewReasonCode =
  | 'bvn_not_verified'
  | 'nin_not_verified'
  | 'id_document_not_verified'
  | 'proof_of_address_not_verified'
  | 'bvn_phone_mismatch'
  | 'details_not_verified'
  | 'review_stopped'
  | 'review_expired';

/** The provider's review of the person, as GET /money/wallet tells it (NUV-02). */
export interface WalletReviewView {
  stage: WalletReviewStage;
  /** Why, when `stage` is `rejected` or `stopped`; empty otherwise. */
  reasons: WalletReviewReasonView[];
  /**
   * True when corrected details may be sent (POST /money/wallet/open). False
   * while the day's tries are used up, however the review stands (round 3,
   * N6): `canResubmitAt` then says when they open again.
   */
  canResubmit: boolean;
  /**
   * When the tries open again, while `canResubmit` is false only because
   * the person's day or this address's hour is used up; else null.
   */
  canResubmitAt: string | null;
  /**
   * When the provider decided (approved, rejected or stopped), or the
   * opening expired; else null.
   */
  decidedAt: string | null;
}

/** WalletView.accountNumberStatus (NUV-04). */
export type WalletAccountNumberStatus = 'none' | 'on_its_way' | 'active';

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
  /**
   * The phone (SMS, Fintava) or the email (Nuvion, R-39) the code went to,
   * masked: `+234 *** *** 4412` or `a***@example.com`.
   */
  sentTo: string;
  /** When Resend becomes available (W37's countdown). */
  resendAvailableAt: string;
  /**
   * Whole seconds from the moment of this answer until Resend opens (0 when it
   * is open). The phone counts this down on its own timer: it never subtracts
   * `resendAvailableAt` from its own clock, which can be minutes out
   * (WALLET-06 round 2, D3).
   */
  resendInSeconds: number;
  expiresAt: string;
}

/**
 * GET, PUT and DELETE /money/device: the one phone that may approve with a
 * fingerprint or a face instead of the PIN (W11, W35; MONEY-14). Not
 * registered: every field but `registered` is null.
 */
export interface ApprovalDeviceView {
  registered: boolean;
  /** The app keeps this to know whether this phone is the registered one. */
  deviceId: string | null;
  biometric: ApprovalBiometricKind | null;
  registeredAt: string | null;
  lastUsedAt: string | null;
}

/** POST /money/device/challenge: one challenge for one biometric approval. */
export interface ApprovalChallengeView {
  challengeId: string;
  /** 32 random bytes, base64url: signed with the request (CONVENTIONS.md section 5). */
  challenge: string;
  /** The registered phone it is for. A phone whose own deviceId differs is not it. */
  deviceId: string;
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
  /**
   * Binds a send to an account that is not saved to this holder's name: send
   * it back as `nameToken` on `POST /money/transfers/bank`. Signed, for this
   * person, short-lived (15 minutes).
   */
  nameToken: string;
}

/** One quick amount on W9: whole naira, in kobo. */
export interface TransferQuickAmountView {
  amountKobo: number;
}

/**
 * GET /money/transfers/presets: what W9 draws that is not the person's own
 * (task WALLET-02). The quick amounts come from settings, not from the design
 * (the setting is documented in transfer-presets.ts); the note's length is the send's own limit.
 */
export interface TransferPresetsView {
  /** Smallest first, at most four. */
  quickAmounts: TransferQuickAmountView[];
  /** The longest note a send takes, in characters. */
  noteMaxLength: number;
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
 * One line of a fee quote, so a review screen can show each charge as its
 * own row (an electricity bill: the bill charge, WAWU's bill fee and the
 * balance-transfer charge). The parts add up to `fee.totalFeeKobo`; a part
 * can be 0 (WAWU's bill fee today, the airtime charge).
 */
export interface FeeQuotePartView {
  code: FeePartCode;
  /** Who the charge is for: Fintava (`provider`) or WAWU (`wawu`). */
  source: 'provider' | 'wawu';
  amountKobo: number;
}

/**
 * GET /money/fees/quote (WALLET-15): what a send, a withdrawal, a purchase
 * or a bill will cost before the PIN (W10, W17, H14). Every figure comes from
 * the server's fee schedule (R-10, config), never from the app or the canvas.
 *
 * The send or payment that follows repeats `totalKobo` as
 * `expectedTotalKobo` and may carry `quoteToken`: if the fee changed in
 * between, or the quote is past `expiresAt`, it is refused with
 * `quote_changed` and the new quote, so the fee shown is always the fee
 * charged. Nothing is reserved.
 */
export interface FeeQuoteView {
  kind: FeeQuoteKind;
  /** The bill's category on a bill; null on every other kind. */
  billCategory: BillCategory | null;
  /**
   * What the recipient gets on a send ("They get ₦25,000"), the price on a
   * purchase, the bill's own amount on a bill.
   */
  amountKobo: number;
  fee: FeeBreakdown;
  /** Each charge in `fee`, in the order a review screen lists them. */
  parts: FeeQuotePartView[];
  /** amountKobo + fee.totalFeeKobo: what leaves the wallet, and what the button shows. */
  totalKobo: number;
  /** False when this would pass today's limit (stopped before the PIN). */
  withinDailyLimit: boolean;
  /** What is left of today's limit; null when no limit is known. */
  remainingTodayKobo: number | null;
  /**
   * This quote, signed by the server: the request that pays it can send it
   * back so the server can check the quote is its own, for this person and
   * this amount, and not past `expiresAt`. Opaque to the app.
   */
  quoteToken: string;
  /** After this the quote is no longer honoured; ask for a new one. */
  expiresAt: string;
  /**
   * FIX-109, additive: how many minutes a send to a bank account usually takes
   * (W17's "Arrives" row), from MONEY_ARRIVAL_BANK_OUT_MINUTES. Only on a
   * `bank_transfer` quote, and only when the setting is set; absent means the
   * Hub makes no promise and the screen draws no line.
   */
  arrivalMinutes?: number;
}

/* ------------------------------------------------------------------ */
/* Transfers                                                           */
/* ------------------------------------------------------------------ */

/**
 * pending:   accepted and debited; the bank has not confirmed (bank sends),
 *            or the provider has not yet said whether it took a send to a
 *            WAWU user whose answer was lost (WALLET-07: asked about by our
 *            reference, never sent again).
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
  /**
   * A sentence for the person while status is pending: the send is not
   * confirmed yet, so nothing says it failed and they are told not to send
   * again (WALLET-07; the same sentence as a payment's). Null otherwise.
   */
  statusMessage: string | null;
  /**
   * The sender's row in the history (`TransactionView.id`): what the receipt
   * routes (`/money/transactions/{id}/receipt`, WALLET-18) are keyed by, so
   * W12's Share can ask for its receipt (BACKEND_GAPS G-66). Null for a send
   * the ledger holds no row of.
   */
  transactionId: string | null;
  createdAt: string;
  completedAt: string | null;
  /**
   * FIX-109, additive: how many minutes a send to a bank account usually takes
   * to reach it (W19's line under the last step), from
   * MONEY_ARRIVAL_BANK_OUT_MINUTES. Only on a bank send that is still
   * `pending`, and only when the setting is set.
   */
  arrivalMinutes?: number;
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
  /**
   * This quote, signed by the server (MONEY-17, the fee quote's token for
   * this price): `POST /money/payments` sends it back with `totalKobo` as
   * `expectedTotalKobo`. Opaque to the app.
   */
  quoteToken: string;
  /** After this the quote is no longer honoured; ask for a new one. */
  expiresAt: string;
}

export type HoldStatus = 'held' | 'released' | 'refunded';

/**
 * What releases a hold to the payee; the opposite outcome refunds the payer.
 * `plan_granted` (TIER-03) is not a held kind's: a tier payment is WAWU's own
 * sale and is never held, a hold is written for it only when the plan cannot
 * be granted after the payment confirmed, and it is refunded at once.
 */
export type HoldReleaseCondition =
  | 'dm_answered'
  | 'event_took_place'
  | 'bill_delivered'
  | 'intake_started'
  | 'plan_granted';

/**
 * Money held between payer and payee in WAWU's merchant wallet (R-19). The
 * price is held; the provider charge on the original payment is not part of
 * it. A refund the payer caused returns the price (R-10); a refund they did
 * not cause (a question that lapsed, an order that failed) returns every
 * naira, the charge too, and `refundedKobo` says which.
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
  /** Set when refunded: what really came back to the payer, read from the refund's own move (the price, or the price and the payment's charge). */
  refundedKobo: number | null;
}

/** A page of holds, newest first. `nextCursor` null means the last page. */
export interface HoldPage {
  items: HoldView[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* Earnings (W39, WALLET-16)                                           */
/* ------------------------------------------------------------------ */

/**
 * What one kind of sale earned: the payee's 85% (R-5) of what was sold,
 * counted from our own records of the sales, labelled as earnings and never
 * as a balance (the provider's balance is the only one, MONEY-11).
 */
export interface EarningStreamView {
  /** What was sold: `content_unlock` (Unlocks), `tip` (Tips), `paid_dm` (Paid DMs), and so on. */
  kind: PaymentKind;
  /** The payee's share of those sales, in kobo. */
  earnedKobo: number;
  /** How many sales it is the share of. */
  sales: number;
}

/** The earnings of a period; `streams` add up to `earnedKobo` exactly. */
export interface EarningsPeriodView {
  earnedKobo: number;
  sales: number;
  /** One entry per kind with a sale in the period, largest first. */
  streams: EarningStreamView[];
}

/**
 * What the caller has earned (W39). Reads our records of the sales; it never
 * calls the provider and is not behind the wallet gate: a creator without a
 * wallet keeps earning, and sees the money waiting (R-11).
 *
 * An earning is the payee's 85% of a finished sale: an ordinary sale (unlock,
 * tip, legal fee, school fees) once it is paid and delivered, a held kind
 * (paid DM, ticket) once the owning feature has released its hold to the
 * payee (it is then earned, and waiting until the move is confirmed). A held
 * price not yet released is `held`, not earned.
 */
export interface EarningsView {
  /** Everything ever earned. */
  allTime: EarningsPeriodView;
  /** The month `thisMonth` is about, YYYY-MM in Africa/Lagos time. */
  month: string;
  /** The earnings of `month` (the current month unless the caller asked for another). */
  thisMonth: EarningsPeriodView;
  /**
   * Earned and not in the wallet yet: no wallet opened, a frozen wallet, or
   * the move not confirmed yet. It lands by itself; there is nothing to tap.
   * Part of `allTime`, not on top of it.
   */
  waiting: EarningsWaitingView;
  /** Paid for and not earned yet: a paid DM unanswered, a ticket before its event. */
  held: EarningsWaitingView;
  /** Whether the caller has a wallet to receive earnings; false shows "Open your wallet" beside the waiting money. */
  walletOpen: boolean;
}

/** A count and a sum in kobo. */
export interface EarningsWaitingView {
  count: number;
  amountKobo: number;
}

/** One piece of content, service or event and what it earned in a month (W39 "per content"). */
export interface EarningContentView {
  kind: PaymentKind;
  targetId: string;
  /** The item as it was named when it was sold. */
  title: string;
  earnedKobo: number;
  sales: number;
  /** The latest sale counted, ISO 8601. */
  lastAt: string;
}

/**
 * A page of per-content earnings for one month, largest first. Every page
 * together adds up to the month's `thisMonth.earnedKobo`. `nextCursor` null
 * means the last page.
 */
export interface EarningContentPage {
  month: string;
  items: EarningContentView[];
  nextCursor: string | null;
}

/**
 * pending:   the debit is not confirmed yet (H18, E10); poll GET /money/payments/{id}.
 *            It ends as completed, failed or reversed once the wallet provider
 *            (or a webhook) says which; a payment the provider never answers
 *            for stays pending, under review, with the same message (MONEY-19).
 * completed: the price moved. What was bought has reached the buyer when
 *            `delivered` is true; until then the owning feature is still
 *            granting it (H18 "Paid, still opening").
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
  /**
   * True once what was paid for has reached the buyer: the payment is
   * `completed` and the owning feature recorded the delivery (or nothing
   * needs delivering). False while `pending`, while a `completed` payment's
   * delivery is unfinished (the sweep keeps delivering it), and on `failed`
   * and `reversed`. The app stops polling when `status` is not `pending` and,
   * for `completed`, `delivered` is true (MONEY-19).
   */
  delivered: boolean;
  /**
   * What the app shows beside a payment that is not finished (MONEY-17,
   * MONEY-19): on `pending`, "We're still confirming this payment. Don't pay
   * again; we'll let you know."; on `completed` with `delivered` false, "Your
   * payment went through and we're finishing it. Don't pay again." Null on
   * every other payment.
   */
  statusMessage: string | null;
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
