/**
 * The ledger's typed inputs (task MONEY-10).
 *
 * The ledger is WAWU's record of every movement of money on a Fintava wallet
 * it knows, mirrored from Fintava in integer kobo. It is never a balance:
 * the balance is Fintava's, read on every request (MONEY-11).
 *
 * Every amount here is a safe integer number of kobo. Naira becomes kobo
 * once, at the Fintava boundary (`fintavaAmountToKobo`, MONEY-06); the
 * database holds BIGINT and nothing on the way multiplies or divides.
 */
import type {
  TransactionCategory,
  TransactionCounterpartyView,
  TransferStatus,
} from '../money-view.type';
import type { PaymentKind } from '../dto/money-enums';

export type LedgerDirection = 'in' | 'out';

/** The wallet one row is on. */
export type LedgerWallet =
  | { kind: 'user'; wawuUserId: string; accountNumber: string }
  | { kind: 'merchant'; accountNumber: string };

/**
 * How the ledger learned of a movement:
 * - `send`: the feature that moved the money recorded it (its category,
 *   counterparty, link and note are the ones kept);
 * - `webhook`: a signed Fintava delivery (MONEY-07's stored events);
 * - `lookup` and `history`: asked of Fintava through the MONEY-06 client.
 */
export type LedgerSource = 'send' | 'webhook' | 'lookup' | 'history';

/**
 * What a reference is. A webhook's reference fields are `delivery`: which
 * of Fintava's references a delivery carries is unconfirmed (BACKEND_GAPS
 * G-19), so none of them is assumed to be ours.
 */
export type LedgerReferenceKind =
  'ours' | 'fintava' | 'tagapay' | 'transaction_id' | 'session' | 'delivery';

export interface LedgerCounterparty {
  kind: TransactionCounterpartyView['kind'];
  name: string | null;
  wawuUserId?: string | null;
  accountNumber?: string | null;
  bankCode?: string | null;
  bankName?: string | null;
}

export interface LedgerLink {
  kind: PaymentKind;
  targetId: string;
  title: string;
}

/** Every reference a movement is known by. At least one is required. */
export interface LedgerReferences {
  /** Our CustomerReference. */
  customerReference?: string | null;
  /** Fintava's `reference` (findable by lookup). */
  fintavaReference?: string | null;
  /** A transfer response's `reference` (not findable by lookup). */
  tagapayTransRef?: string | null;
  fintavaTransactionId?: string | null;
  sessionId?: string | null;
  /** A webhook's reference fields, meaning unconfirmed (G-19). */
  delivery?: readonly (string | null | undefined)[];
}

/** One side of one movement, as a source saw it. */
export interface LedgerMovementInput {
  wallet: LedgerWallet;
  direction: LedgerDirection;
  status: TransferStatus;
  category: TransactionCategory;
  /** What moved, before fees. Positive. */
  amountKobo: number;
  /** What Fintava took on top (out rows). Default 0. */
  feeKobo?: number;
  /**
   * Fintava's charge and WAWU's fee as quoted (R-10), when the sender knows
   * them. Once the provider's own charge is known (its answer, its record, a
   * signed report), the provider's charge is what a payment's row says here,
   * not the quoted one (MONEY-17 round 8, F1).
   */
  providerFeeKobo?: number | null;
  wawuFeeKobo?: number | null;
  /** Default: amount + fee on an out row, amount on an in row. */
  totalKobo?: number;
  /**
   * The sighting carries no fee or total of its own (a lookup, a history
   * row: Fintava's carry no charge for a wallet-to-wallet send), so when the
   * row exists, the figures it holds stand: the `feeKobo` and `totalKobo`
   * given are used only to create it. Read under the row's lock, so a figure
   * another job wrote since the caller read the row (a signed report of the
   * real charge, MONEY-17 round 8) is never "disagreed with" by a stale one.
   * The amount is still compared.
   */
  figuresStand?: boolean;
  counterparty?: LedgerCounterparty | null;
  link?: LedgerLink | null;
  note?: string | null;
  narration?: string | null;
  references: LedgerReferences;
  transferId?: string | null;
  paymentId?: string | null;
  failureReason?: string | null;
  source: LedgerSource;
  sourceEventId?: string | null;
  /** When the money moved, if the source says; else now. */
  occurredAt?: Date | null;
}

export interface LedgerRecordResult {
  entryId: string;
  /** True when this call wrote the row; false when it was already there. */
  created: boolean;
  /** Set when the sighting disagreed with the stored amounts (kept, reported). */
  discrepancy: string | null;
  /**
   * Set when a webhook reported a COMPLETED debit of a payment (a row with a
   * `paymentId`) at the same amount but another charge than the row holds
   * (MONEY-17 round 8, R7-1). The row keeps its figures (a disagreement is a
   * stop), so the paying feature is told what the provider reported and
   * completes the payment at it (`LedgerService.onPaymentDebitSighted`).
   */
  debitSighting?: LedgerDebitSighting | null;
}

/**
 * What a signed provider report (a webhook) says a payment's debit really
 * was, in kobo, when its charge is not the one the buyer's row holds. The
 * report is the provider's own record of what it took, so the payment treats
 * it like the provider's answer to the send or its lookup: one completion,
 * whichever of them tells it first.
 */
export interface LedgerDebitSighting {
  entryId: string;
  paymentId: string;
  amountKobo: bigint;
  feeKobo: bigint;
  totalKobo: bigint;
}

/** What a debit_transfer_reversal reported, in kobo. */
export interface LedgerReversalInput {
  /** References that may name the reversed debit. */
  references: readonly string[];
  reversalReference: string | null;
  amountKobo: number | null;
  chargesKobo: number | null;
  totalKobo: number | null;
  at: Date;
}

export type LedgerReversalResult =
  | { state: 'applied'; entryId: string; changed: boolean }
  /**
   * The reversal's figures differ from the row's, or the row is not one a
   * reversal can follow (MONEY-08 round 3): written on the row's
   * `discrepancy`, nothing else changed.
   */
  | { state: 'disagrees'; entryId: string; discrepancy: string }
  | { state: 'no_match' }
  | { state: 'ambiguous'; entryIds: string[] };
