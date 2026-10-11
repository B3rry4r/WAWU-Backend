/**
 * What the nightly check finds and reports (task MONEY-16).
 *
 * Two kinds of finding, never mixed:
 * - a MISMATCH is a difference between WAWU's ledger and the wallet
 *   provider's own record (a debit one side has and the other does not, a
 *   wrong amount, a balance that is not where the ledger says it should be,
 *   held money that is not where it should be, a merchant charge that did
 *   not land). The provider's record is the truth; the check only reports.
 * - a LOOK is something a person at WAWU has to decide, though nothing
 *   differs: a payment or a hold in review, money owed to a deleted payee,
 *   a ledger row the ledger itself marked as disagreeing with the provider.
 *
 * Every amount in a report is kobo written as decimal text. A reference is
 * an id WAWU wrote (a ledger row, a payment, a hold, our reference at the
 * provider) or the provider's wallet id: never a name, a phone number or an
 * account number.
 */

export const CHECK_IDS = [
  'movements',
  'merchant_movements',
  'balances',
  'held_money',
  'merchant_charges',
  'ledger_rows',
  'payments',
  'holds',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * - `ok`: made, nothing found;
 * - `differences`: made, at least one mismatch;
 * - `needs_a_look`: made, nothing differs, a person has to look at something;
 * - `incomplete`: not all of it could be made (a wallet the provider would
 *   not answer for, history longer than the pages read);
 * - `not_checked`: not made at all, because the provider cannot be asked
 *   (not set up on this server, or its adapter cannot do it yet).
 */
export type CheckState =
  'ok' | 'differences' | 'needs_a_look' | 'incomplete' | 'not_checked';

export type FindingKind =
  // movements and merchant_movements
  | 'provider_only'
  | 'ledger_only'
  | 'amount_differs'
  | 'status_differs'
  | 'status_unknown'
  // balances
  | 'balance_differs'
  // held_money
  | 'held_money_short'
  | 'hold_missing'
  | 'hold_move_row'
  // merchant_charges
  | 'merchant_charge_missing'
  | 'merchant_charge_differs'
  // ledger_rows
  | 'ledger_discrepancy'
  | 'ledger_pending_old'
  | 'failed_send_no_reversal'
  | 'payment_rows'
  // payments
  | 'payment_in_review'
  | 'payment_charge_review'
  | 'payment_debit_above_quote'
  | 'payment_paid_twice'
  | 'payment_pending_old'
  // holds
  | 'hold_in_review'
  | 'hold_move_stuck'
  | 'hold_waiting_past_limit'
  | 'hold_payee_deleted';

export interface Finding {
  check: CheckId;
  severity: 'mismatch' | 'look';
  kind: FindingKind;
  /** A reference a person can search for. See the file header. */
  ref: string;
  /** A short plain sentence. No name, phone number or account number. */
  detail: string;
  /** The figure on WAWU's side, or the one that matters, in kobo. */
  amountKobo?: string;
  /** The figure on the provider's side, or the one it is compared with. */
  otherKobo?: string;
}

export interface CheckSummary {
  id: CheckId;
  state: CheckState;
  /** How many things were compared (wallets, rows, holds, payments). */
  checked: number;
  /** How many findings this check made. */
  found: number;
  /** Why it was not made, or what it could not read. */
  note: string | null;
}

/** Why a wallet was not checked in full. */
export type WalletSkip =
  | 'not_set_up'
  | 'unreadable'
  | 'not_supported'
  | 'history_incomplete'
  | 'moving'
  | 'not_reached';

export type Verdict =
  'clean' | 'needs_a_look' | 'differences' | 'incomplete' | 'not_checked';

/** A count, with the money it stands for when it has some. */
export interface Notice {
  count: number;
  amountKobo?: string;
}

export interface MoneyCheckReport {
  version: 1;
  provider: string;
  /** The Lagos date the run belongs to. */
  night: string;
  windowFrom: string | null;
  windowTo: string;
  startedAt: string;
  finishedAt: string;
  verdict: Verdict;
  wallets: {
    total: number;
    /** Wallets whose balance and debits were both compared in full. */
    checked: number;
    notChecked: Partial<Record<WalletSkip, number>>;
  };
  checks: CheckSummary[];
  /** The held money figures: never shown as a balance. */
  held: {
    openCount: number;
    openKobo: string;
    /** What the open holds need to be in WAWU's account, in kobo. */
    requiredKobo: string;
    /** The provider's available balance of WAWU's account; null: not read. */
    merchantAvailableKobo: string | null;
  };
  mismatches: Finding[];
  look: Finding[];
  /** Findings beyond what is kept in `mismatches` and `look`. */
  omitted: { mismatches: number; look: number };
  /** Things worth knowing that are neither a mismatch nor a look. */
  notices: Record<string, Notice>;
}

/** The most findings of each kind kept in a stored report. */
export const REPORT_KEEP = 500;

/** The most findings handed on in one email. */
export const REPORT_MAIL = 100;
