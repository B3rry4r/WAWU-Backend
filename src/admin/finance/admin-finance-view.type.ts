/**
 * Wire shapes for `/api/hub/admin/finance/*`.
 *
 * ── EVERY AMOUNT ON THIS SURFACE IS INTEGER KOBO, EXCEPT WHERE SAID ──────
 * A 15% cut of a whole-naira charge is not a whole naira (₦999 splits
 * ₦149.85 / ₦849.15), so a naira-denominated split would either lie or be a
 * float. Money is never a float in this codebase, so the revenue figures are
 * carried in kobo and the field names say so. `CreditSpendEarning` already
 * stores kobo for exactly this reason, so its rows drop straight in.
 *
 * The WALLET figures are the exception and are named `...Naira`:
 * `WalletLedgerEntry.amount` and `WalletWithdrawal.amount` are whole-naira
 * columns, and re-denominating them here would invent precision the rows do
 * not carry.
 *
 * ── AND NONE OF THEM IS A BALANCE ────────────────────────────────────────
 * A creator's wallet is a Flutterwave payout subaccount in their own name,
 * custodied by Flutterwave under their CBN licence. Flutterwave's figure is
 * the authoritative balance, and it reaches this surface through the wallet
 * module's own gateway, on `AdminFinanceWalletBalanceView`. Everything else
 * here is a SUM OF ROWS and is named as one: what was charged, what was
 * instructed, what was confirmed.
 */

/** The revenue streams this platform actually has rows for. */
export const ADMIN_FINANCE_STREAMS = [
  'content',
  'tips',
  'dm',
  'credits',
  'verification',
  'events',
  'shop',
] as const;

export type AdminFinanceStream = (typeof ADMIN_FINANCE_STREAMS)[number];

/**
 * One money vocabulary across six source tables, so a filter means the same
 * thing on every row.
 *
 * `settled` is the only status that counts as revenue. Each stream's native
 * column is carried alongside on `sourceStatus`, unchanged, so nothing is
 * lost in the flattening.
 */
export const ADMIN_FINANCE_TX_STATUSES = [
  'settled',
  'pending',
  'failed',
  'refunded',
  'cancelled',
] as const;

export type AdminFinanceTxStatus = (typeof ADMIN_FINANCE_TX_STATUSES)[number];

/** The window a figure covers, echoed back so a screen can label its own numbers. */
export interface AdminFinancePeriodView {
  /** Inclusive. ISO 8601. */
  from: string;
  /** Exclusive. ISO 8601. */
  to: string;
  /** True when the caller passed neither bound and got this calendar month. */
  isDefaultPeriod: boolean;
}

/** Gross, and the two halves it splits into. Always adds up exactly. */
export interface AdminFinanceMoneyView {
  grossKobo: number;
  wawuShareKobo: number;
  creatorShareKobo: number;
  transactionCount: number;
}

export interface AdminFinanceStreamTotalsView extends AdminFinanceMoneyView {
  stream: AdminFinanceStream;
  /** Short label, so a dashboard does not have to keep its own copy of these. */
  label: string;
  /** Whole percent of gross that goes to the creator. 85 everywhere there is one, 0 where there is not. */
  creatorSharePct: number;
  /** Which table and which rows this figure was summed from. */
  source: string;
  /** The native statuses counted. Anything else contributed nothing. */
  countedStatuses: string[];
}

/**
 * The spend-side truth about credits, reported beside the purchase-side gross
 * rather than folded into it.
 *
 * A credit pack is money WAWU banks at PURCHASE. The host's 85% of it is only
 * attributed when a member SPENDS a credit, against the actual purchase lot
 * that funded it (`CreditLot` / `CreditSpendEarning`). Those are two different
 * events in two different periods, so the stream total splits the purchase
 * 85/15 as the platform rule says, and this block reports what has actually
 * been attributed to hosts in the same window.
 */
export interface AdminFinanceCreditsAttributionView {
  note: string;
  /** Credits spent in the period, a COUNT. Never a naira value. */
  creditsSpent: number;
  /** Of those, the ones backed by a completed purchase. The rest were worth ₦0 because WAWU banked ₦0 for them. */
  creditsFunded: number;
  /** Kobo WAWU had banked for the funded credits, from the lots that paid for them. */
  fundedGrossKobo: number;
  hostShareKobo: number;
  platformShareKobo: number;
}

export interface AdminFinanceSummaryView {
  period: AdminFinancePeriodView;
  currency: 'NGN';
  amountsIn: 'kobo';
  totals: AdminFinanceMoneyView;
  streams: AdminFinanceStreamTotalsView[];
  creditsAttribution: AdminFinanceCreditsAttributionView;
  /** What this response is and is not, in one sentence a screen can print. */
  basis: string;
}

/** A WAWU account, as much of it as this backend stores. */
export interface AdminFinancePartyView {
  wawuId: string;
  /**
   * `UserProfile.handle`. This backend stores no first/last name for a WAWU
   * account - names live in WAWU ID, on the token claim, and are never
   * persisted here. The handle is the whole of the display name available.
   */
  handle: string | null;
}

/** One money movement, whichever table it came out of. */
export interface AdminFinanceTransactionView {
  /** The source row's own primary key. Unique within a stream, not across them. */
  id: string;
  stream: AdminFinanceStream;
  /** The source row's own timestamp: when the charge was opened. ISO 8601. */
  occurredAt: string;
  /** Who is owed the creator share. Null on the streams that have no creator counterparty. */
  creator: AdminFinancePartyView | null;
  /** Who paid. Null where the source row does not name one. */
  buyer: AdminFinancePartyView | null;
  grossKobo: number;
  wawuShareKobo: number;
  creatorShareKobo: number;
  status: AdminFinanceTxStatus;
  /** The source column, verbatim, before it was flattened into `status`. */
  sourceStatus: string;
  flutterwaveTxRef: string | null;
  flutterwaveTxId: string | null;
}

/** One withdrawal that left a creator's wallet for their own bank account. */
export interface AdminFinancePayoutView {
  /** The `WalletLedgerEntry` id. */
  id: string;
  creator: AdminFinancePartyView;
  amountNaira: number;
  /** `WalletLedgerEntry.status`: pending, completed or failed. */
  status: string;
  /** WAWU's own idempotency key, sent to Flutterwave and echoed on the webhook. */
  reference: string;
  /** Flutterwave's transfer id, once the request reached them. */
  transferId: string | null;
  failureReason: string | null;
  bankCode: string | null;
  /** Resolved from the bank before sending, never typed by the creator. */
  accountName: string | null;
  /** Last four digits. The full number is never returned on this surface. */
  accountNumberLast4: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** Creator money that has been earned and has not reached a wallet. */
export interface AdminFinanceOwedStreamView {
  stream: AdminFinanceStream;
  /** Source rows carrying an unpaid creator share. */
  sourceRows: number;
  creatorShareNaira: number;
  /** Whether the wallet funding sweep covers this stream at all. */
  sweptAutomatically: boolean;
  why: string;
}

export interface AdminFinancePayoutsView {
  period: AdminFinancePeriodView;
  currency: 'NGN';
  amountsIn: 'naira';
  withdrawals: {
    items: AdminFinancePayoutView[];
    page: number;
    perPage: number;
    total: number;
    /** Confirmed, in-flight and failed withdrawal money for the period. */
    completedNaira: number;
    pendingNaira: number;
    failedNaira: number;
  };
  owed: {
    note: string;
    /** Earnings WAWU has instructed and Flutterwave has not confirmed. Lifetime, not period. */
    instructedAwaitingConfirmation: { count: number; amountNaira: number };
    /** Earning instructions Flutterwave refused. These need a person. Lifetime, not period. */
    instructionsFailed: { count: number; amountNaira: number };
    /** Earned by a creator with no wallet ledger entry against the source row at all. Lifetime, not period. */
    earnedNotInstructed: AdminFinanceOwedStreamView[];
    earnedNotInstructedTotalNaira: number;
  };
}

/**
 * Flutterwave's figure, or an honest null.
 *
 * Never computed here. When the gateway cannot be reached the balance is null
 * and `unavailableReason` says so - a stale or summed number presented as a
 * balance is the one thing this surface must not do.
 */
export interface AdminFinanceWalletBalanceView {
  ngn: number | null;
  source: 'flutterwave';
  unavailableReason: string | null;
}

/** The payout subaccount itself, as this backend recorded it when Flutterwave opened it. */
export interface AdminFinanceSubaccountView {
  accountReference: string;
  bankName: string | null;
  /** Last four digits of the creator's own NUBAN at Flutterwave MFB. */
  accountNumberLast4: string | null;
  status: string;
  openedAt: string;
}

/**
 * Lifetime sums over `WalletLedgerEntry` for one creator - the same three
 * figures `GET /wallet` shows the creator themselves, from the same columns,
 * so the two screens cannot disagree.
 */
export interface AdminFinanceWalletLifetimeView {
  /** Completed earnings less completed reversals. What WAWU instructed and Flutterwave confirmed. */
  earnedInstructedNaira: number;
  /** Earnings instructed and not yet confirmed either way. */
  earningsPendingNaira: number;
  withdrawnNaira: number;
}

export interface AdminFinanceWalletView {
  creator: AdminFinancePartyView;
  /** `CreatorState.kycStatus`, with `not_started` split out the way the creator's own screen splits it. */
  kycStatus: string | null;
  /** Whether money may leave for an outside bank account. KYC approved is the whole of it. */
  withdrawalsEnabled: boolean;
  /** Null when Flutterwave has never opened one for this account. */
  payoutSubaccount: AdminFinanceSubaccountView | null;
  balance: AdminFinanceWalletBalanceView;
  lifetime: AdminFinanceWalletLifetimeView;
}

/** One movement in a wallet's own ledger. */
export interface AdminFinanceWalletEntryView {
  id: string;
  kind: string;
  amountNaira: number;
  status: string;
  reference: string;
  transferId: string | null;
  /** What produced it: `purchase`, `direct_message`, or null for a withdrawal. */
  sourceType: string | null;
  sourceId: string | null;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface AdminFinanceWalletDetailView extends AdminFinanceWalletView {
  currency: 'NGN';
  amountsIn: 'naira';
  history: AdminFinanceWalletEntryView[];
  historyTotal: number;
}
