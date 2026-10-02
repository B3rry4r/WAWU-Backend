/**
 * The Fintava client's typed inputs and results (task MONEY-06).
 *
 * Every amount here is integer kobo; the client converts at the boundary
 * (fintava-amount.ts). Fintava's own wire shapes are read field by field in
 * fintava-client.ts from `unknown`, never cast, because the sandbox showed
 * they differ from the published docs (mobile repo `docs/fintava/sandbox/`).
 *
 * Identity Fintava returns but we did not ask for (BVN, NIN, date of birth,
 * address, the merchant administrator's login record, all embedded in
 * transaction-by-id and freeze responses, `sandbox/12-`, `15-`) is dropped
 * here: no result type below has a field for it.
 */

/** Where the client sends requests. Live is reachable from config only. */
/**
 * Where the client sends requests. `unconfigured`: production with
 * FINTAVA_BASE_URL not set (before OPS-10): the server runs, the client sends
 * nothing and every call fails as `not_configured`.
 */
export type FintavaEnvironment = 'sandbox' | 'live' | 'local' | 'unconfigured';

/** Fintava's transaction status values (upper case; `sandbox/10-`). */
export const FINTAVA_TXN_STATUSES = [
  'PENDING',
  'SUCCESS',
  'CANCELLED',
  'FAILURE',
  'ONGOING',
] as const;
export type FintavaTxnStatus = (typeof FINTAVA_TXN_STATUSES)[number];

/** Phone networks as the bill calls name them. */
export type FintavaNetwork = 'MTN' | 'GLO' | 'AIRTEL' | '9MOBILE';

/** Cable providers: only these two exist, and the name is case-sensitive. */
export type FintavaCableProvider = 'GOTV' | 'DSTV';

export interface FintavaPageQuery {
  /** From 1. */
  page?: number;
  /** 1 to 100. */
  take?: number;
}

export interface FintavaPage<T> {
  items: T[];
  page: number;
  take: number;
  itemCount: number;
  pageCount: number;
  hasNextPage: boolean;
}

// ---------------------------------------------------------------------------
// Customers (plan item 2)
// ---------------------------------------------------------------------------

export interface FintavaCreateCustomerInput {
  firstName: string;
  lastName: string;
  /** Any common Nigerian mobile form; sent to Fintava in local `0...` form. */
  phone: string;
  email: string;
  address: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
  /** 11 digits. */
  bvn: string;
  /** 11 digits. Not validated by Fintava, and returned as null, but sent. */
  nin: string;
}

/**
 * A customer's four ids are not interchangeable (`sandbox/07-`):
 * `customerId` is `/customers/{id}`, `/txn?customerId=` and a bank send's
 * `sourceId`; `walletId` is balance, freeze and unfreeze; `accountNumber` is
 * wallet-to-wallet and name checks; `tagpayCustomerId` is what a transfer
 * response calls `source_customer_id`; `recordId` is used by nothing we call
 * (as a `sourceId` it answers 404).
 */
export interface FintavaCustomerIds {
  customerId: string;
  walletId: string;
  accountNumber: string;
  /** Only on reads (`/customers/{id}`, the list); null from create. */
  recordId: string | null;
  /** Only on reads; null from create. */
  tagpayCustomerId: string | null;
}

export interface FintavaCustomer extends FintavaCustomerIds {
  firstName: string;
  lastName: string;
  accountName: string;
  isFrozen: boolean;
  /** The wallet's status, `active` so far. */
  walletStatus: string;
  /** `TIER_2` for a new wallet; never in the create response (null there). */
  tier: string | null;
}

// ---------------------------------------------------------------------------
// Balances (plan item 3)
// ---------------------------------------------------------------------------

export interface FintavaWalletBalance {
  availableKobo: number;
  bookedKobo: number;
  tier: string | null;
}

export interface FintavaMerchantBalance extends FintavaWalletBalance {
  accountName: string;
  accountNumber: string;
}

// ---------------------------------------------------------------------------
// Transactions (plan items 4, 8)
// ---------------------------------------------------------------------------

/**
 * One transaction, from history or a lookup. References, named for what
 * they are (`sandbox/11-`): `customerReference` is OURS (the
 * `CustomerReference` we sent, null on charges); `fintavaReference` is
 * Fintava's `reference`, also findable by lookup; `tagapayTransRef` is the
 * one a transfer response calls `reference`, which a lookup cannot find
 * (only the by-id record carries it).
 */
export interface FintavaTransaction {
  id: string;
  createdAt: string;
  updatedAt: string;
  amountKobo: number;
  transType: string;
  /** DEBIT or CREDIT. History lists only debits (`sandbox/09-`, `10-`). */
  entry: string;
  status: string;
  customerReference: string | null;
  fintavaReference: string | null;
  tagapayTransRef: string | null;
  narration: string | null;
  senderDetails: string | null;
  recipientDetails: string | null;
  senderBank: string | null;
  receiverBank: string | null;
  sessionId: string | null;
  /** The owning customer's customerId, when the row names one. */
  customerId: string | null;
  /** Fee fields: only the by-id record carries them; null elsewhere. */
  platformCommKobo: number | null;
  merchantCommKobo: number | null;
  lomaChargeKobo: number | null;
  /** Bill fields: only the by-id record carries them. */
  meterToken: string | null;
  meterNumber: string | null;
  discoRef: string | null;
}

export interface FintavaCustomerHistoryQuery extends FintavaPageQuery {
  customerId: string;
  status?: FintavaTxnStatus;
}

export interface FintavaMerchantHistoryQuery extends FintavaPageQuery {
  status?: FintavaTxnStatus;
  /** YYYY-MM-DD. */
  startDate?: string;
  /** YYYY-MM-DD. */
  endDate?: string;
  order?: 'ASC' | 'DESC';
}

/**
 * A lookup has three answers, not two (`sandbox/14-`): `found`; `absent`
 * (Fintava said not found: 404 by reference, `data: null` by id); and
 * `unknown`, which is a 200 whose body is `{}`. A refused bank send's
 * record turns into `{}` by reference while history still lists it as
 * PENDING, so `unknown` never counts as "safe to send again".
 */
export type FintavaLookup =
  | { state: 'found'; transaction: FintavaTransaction }
  | { state: 'absent' }
  | { state: 'unknown' };

// ---------------------------------------------------------------------------
// Moving money (plan items 7, 9, 10)
// ---------------------------------------------------------------------------

export interface FintavaWalletTransferInput {
  senderAccountNumber: string;
  receiverAccountNumber: string;
  amountKobo: number;
  /** Ours, always (derived from our own transaction id). */
  customerReference: string;
  narration?: string;
}

/** A customer's send to a bank (`POST /bank/credit`). */
export interface FintavaBankTransferInput {
  /** The customerId (`userInfo.id`), never the record id. */
  sourceCustomerId: string;
  accountNumber: string;
  accountName?: string;
  /** The bank's `code` from the bank list. */
  sortCode: string;
  amountKobo: number;
  customerReference: string;
  narration?: string;
}

/** WAWU's merchant wallet to a bank (`POST /bank/credit/merchant`). */
export interface FintavaMerchantBankTransferInput {
  accountNumber: string;
  accountName: string;
  sortCode: string;
  amountKobo: number;
  customerReference: string;
  narration?: string;
}

/**
 * What Fintava answered for an accepted send. The response swaps its
 * reference names (`sandbox/11-`): its `customerReference` field is
 * Fintava's findable `reference` (here `fintavaReference`), and its
 * `reference` field is the unfindable `tagapayTransRef`. Look a send up by
 * `customerReference` (ours).
 */
export interface FintavaTransferReceipt {
  customerReference: string;
  fintavaReference: string;
  tagapayTransRef: string;
  /** Fintava's transaction id when the response carries one (bank sends). */
  transactionId: string | null;
  amountKobo: number;
  totalKobo: number;
  feeKobo: number;
  lomaChargeKobo: number | null;
  sourceAccountNumber: string | null;
  /** The sender's balance after; the receiver's is not returned. */
  sourceAvailableKobo: number | null;
  sourceBookedKobo: number | null;
}

/** Whose history holds a send's debit row. */
export type FintavaSender =
  { kind: 'merchant' } | { kind: 'customer'; customerId: string };

export type FintavaSendKind = 'wallet_to_wallet' | 'bank_transfer';

/** What Fintava knows about one of our references, lookup then history. */
export type FintavaReconciliation =
  | {
      state: 'found';
      source: 'lookup' | 'history';
      transaction: FintavaTransaction;
    }
  | { state: 'absent' }
  | {
      state: 'unknown';
      why: 'empty_lookup' | 'unreachable' | 'unrecognised' | 'too_soon';
    };

/**
 * What may be done with a send whose outcome was unknown:
 * - `settled`: it went through. Never send it again.
 * - `wait`: pending, or Fintava cannot say. Never send; ask Fintava again on the next check.
 * - `resend_same_reference`: wallet-to-wallet only, when the lookup answered
 *   Fintava's own `404 "Transaction not found!"`, history has no row, and
 *   the money timeout plus the safety window has passed since the first
 *   send. A refused wallet-to-wallet send writes nothing and leaves its
 *   reference usable (`sandbox/13-`).
 * - `resend_new_reference`: the old reference is used up (a failed record,
 *   or any bank send: a refused bank send can leave a PENDING record and
 *   uses its reference up, `sandbox/14-`).
 */
export type FintavaRetryDecision =
  | { action: 'settled'; transaction: FintavaTransaction }
  | {
      action: 'wait';
      why:
        | 'pending'
        | 'empty_lookup'
        | 'unreachable'
        | 'unrecognised'
        | 'too_soon';
    }
  | { action: 'resend_same_reference' }
  | {
      action: 'resend_new_reference';
      why: 'failed' | 'absent';
      transaction: FintavaTransaction | null;
    };

export interface FintavaRetryOutcome {
  decision: FintavaRetryDecision;
  /** Set only when this call sent the money again and Fintava accepted it. */
  receipt: FintavaTransferReceipt | null;
}

// ---------------------------------------------------------------------------
// Banks and names (plan items 5, 6)
// ---------------------------------------------------------------------------

export interface FintavaBank {
  /** The `sortCode`; a string, not always 6 digits; the key. */
  code: string;
  name: string;
}

export interface FintavaBankAccountName {
  /** `data.status === true` and `responseCode === "00"`. */
  matched: boolean;
  accountName: string | null;
  accountNumber: string;
  bankCode: string;
  responseCode: string | null;
}

export interface FintavaWalletAccountName {
  accountNumber: string;
  accountName: string;
}

// ---------------------------------------------------------------------------
// Freeze (plan item 12)
// ---------------------------------------------------------------------------

export interface FintavaWalletState {
  walletId: string;
  accountNumber: string;
  isFrozen: boolean;
  walletStatus: string;
  tier: string | null;
}

// ---------------------------------------------------------------------------
// Bills (plan item 11)
// ---------------------------------------------------------------------------

export interface FintavaDisco {
  code: string;
  description: string;
  minimumKobo: number;
  maximumKobo: number;
  available: boolean;
}

export interface FintavaDataBundle {
  /** Codes repeat across networks: key on network and code together. */
  code: string;
  title: string;
  priceKobo: number;
  validity: string;
}

export interface FintavaCablePlan {
  code: string;
  title: string;
  provider: string;
  priceKobo: number;
  available: boolean;
}

export type FintavaMeterPlan = 'prepaid' | 'postpaid';

export interface FintavaMeterPreviewInput {
  meterNumber: string;
  disco: string;
  planType: FintavaMeterPlan;
}

/**
 * A meter preview's success body has not been seen (no sandbox meter is
 * known, question 11). Its scalar fields are kept as they came.
 */
export interface FintavaMeterPreview {
  details: Record<string, string | number | boolean | null>;
}

export interface FintavaElectricityInput extends FintavaMeterPreviewInput {
  amountKobo: number;
}

export interface FintavaAirtimeInput {
  network: FintavaNetwork;
  /** Whole naira, ₦100 or more (`sandbox/19-`). */
  amountKobo: number;
  phone: string;
}

export interface FintavaDataInput {
  network: FintavaNetwork;
  bundleCode: string;
  phone: string;
}

export interface FintavaCableInput {
  provider: FintavaCableProvider;
  smartcardNumber: string;
  planCode: string;
}

/**
 * A bill purchase Fintava accepted. No purchase has gone through in the
 * sandbox (question 17), so the body is unseen: the client reads the fields
 * a transaction carries elsewhere and keeps every scalar it got. Bill calls
 * take no `CustomerReference`, so a purchase whose answer was lost can only
 * be found by id or in history: confirm with `getTransactionById`.
 */
export interface FintavaBillReceipt {
  transactionId: string | null;
  fintavaReference: string | null;
  amountKobo: number | null;
  meterToken: string | null;
  details: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Identity checks (plan item 1). Each one is charged, even when it fails.
// ---------------------------------------------------------------------------

export interface FintavaBvnIdentity {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** YYYY-MM-DD. */
  dateOfBirth: string | null;
  /** As Fintava sends it (local form). */
  phone: string | null;
  gender: string | null;
  /** Base64 photo, for the selfie match. */
  imageBase64: string | null;
}

export interface FintavaSelfieInput {
  bvn: string;
  /** Base64 image, no data: prefix. */
  imageBase64: string;
}

/**
 * A selfie match's answer. It is a face match against the BVN record's
 * photo, not a liveness check (Fintava offers none). The success body is
 * unseen (a failed match is a 400, `sandbox/05-`; question 6) and Fintava
 * documents no verdict field (its 200 example is `{}`), so it is read
 * failing closed: a match only on an explicit boolean `true` verdict with
 * nothing saying otherwise; an explicit "no" is `matched: false`; an answer
 * with no verdict is a `bad_response` error, never a match. Nothing else of
 * it is passed on (it may echo the BVN or carry a photo).
 */
export interface FintavaSelfieResult {
  /** True only on an explicit `true` verdict; false on an explicit "no". */
  matched: boolean;
  /** Fintava's confidence score, as sent, when the answer has one; else null. */
  confidence: number | null;
}
