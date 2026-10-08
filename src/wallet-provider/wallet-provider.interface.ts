/**
 * The wallet provider seam (task MONEY-20).
 *
 * One provider-neutral interface between WAWU's money code (`src/money/`)
 * and whichever company holds the wallets. The owner, 6 Oct 2026: Fintava is
 * being replaced by Nuvion, and "Fintava's removal should not be permanent
 * but something of an easy roll back". So nothing under `src/money/` talks
 * to a provider's client: every service takes `WALLET_PROVIDER` (and the PIN
 * reset takes `OTP_SENDER`), and `WALLET_PROVIDER=fintava|nuvion` picks the
 * adapter at boot (wallet-provider.module.ts). Rolling back is changing that
 * setting and restarting.
 *
 * Shaped for both providers (mobile repo task MONEY-20 lists the sources):
 * - Fintava opens a customer and its account number in one call, checks a
 *   BVN and matches a selfie itself, and texts.
 * - Nuvion takes a KYC submission separately (entity, documents, an
 *   onboarding submission), issues the account number asynchronously,
 *   checks liveness through a hosted session, names an account at a bank
 *   with `POST /counterparty-lookups`, and has no SMS (codes go by email,
 *   owner ruling).
 * A method one provider has no equivalent for answers a `WalletProviderError`
 * of kind `not_supported` (never a guess, never a silent success);
 * `capabilities` says which in advance.
 *
 * Amounts are integer kobo as `bigint`. Naira becomes kobo once, inside the
 * adapter. A service that hands a figure to code that takes a number
 * converts with `safeKoboNumber`, which refuses anything a number cannot hold
 * exactly.
 *
 * Nothing here is a provider's wire shape: an adapter reads its provider's
 * answers field by field and maps them to these types. Fintava's quirks
 * (its three references, lookups that answer `{}`, its retry rules, its
 * webhook payloads) stay inside `src/fintava/`.
 */
import type {
  TransactionCategory,
  TransferStatus,
} from '../money/money-view.type';

/** Nest injection token for the selected `WalletProvider`. */
export const WALLET_PROVIDER = Symbol('WALLET_PROVIDER');

/** Nest injection token for the selected `OtpSender` (PIN reset codes). */
export const OTP_SENDER = Symbol('OTP_SENDER');

/** The providers `WALLET_PROVIDER` may name. */
export const WALLET_PROVIDER_NAMES = ['fintava', 'nuvion'] as const;
export type WalletProviderName = (typeof WALLET_PROVIDER_NAMES)[number];

/**
 * A kobo bigint as a number, for the code that takes numbers (the ledger,
 * the views). Refuses a value a number cannot hold exactly.
 */
export function safeKoboNumber(kobo: bigint): number {
  const n = Number(kobo);
  if (!Number.isSafeInteger(n) || BigInt(n) !== kobo) {
    throw new RangeError(
      'A provider amount is beyond what a number holds exactly.',
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * How long the provider is waited for, and the resend rule's window. A
 * service reads these instead of a provider's config.
 */
export interface WalletProviderTimings {
  /** Reads: lists, balances, lookups, history, name checks. */
  readonly readTimeoutMs: number;
  /** Anything that moves money or opens an account. */
  readonly moneyTimeoutMs: number;
  /** Identity checks. */
  readonly checkTimeoutMs: number;
  /**
   * Added to `moneyTimeoutMs`: a send or an opening whose answer was lost
   * is never treated as "never happened" sooner than both after it was sent.
   */
  readonly resendSafetyMs: number;
  /** What the app is told to wait before trying a refused read again. */
  readonly retryAfterSeconds: number;
}

/** What a provider can do, so a caller can plan before it asks. */
export interface WalletProviderCapabilities {
  /** Matches a selfie against the BVN record's photo (`matchSelfie`). */
  readonly selfieMatch: boolean;
  /** Runs a hosted liveness check (`startLivenessSession`). */
  readonly hostedLiveness: boolean;
  /** Takes the person's KYC as its own submission (`submitKyc`). */
  readonly separateKyc: boolean;
  /** Issues the account number after opening, not in the opening's answer. */
  readonly asyncAccountNumber: boolean;
  /** Checks a BVN and answers its holder's details (`checkIdentity`). */
  readonly identityLookup: boolean;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** What a BVN check answered. The photo is for the selfie match only. */
export interface ProviderIdentity {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** YYYY-MM-DD. */
  dateOfBirth: string | null;
  /** As the provider sent it. */
  phone: string | null;
  gender: string | null;
  /** Base64 photo, for the selfie match. Never stored or passed on. */
  imageBase64: string | null;
}

export interface ProviderSelfieInput {
  bvn: string;
  /** Base64 image, no data: prefix. */
  imageBase64: string;
}

/** A selfie match's answer: true only on an explicit match. */
export interface ProviderSelfieResult {
  matched: boolean;
  confidence: number | null;
}

/** A hosted liveness check, started for one person. */
export interface ProviderLivenessSession {
  sessionId: string;
  /** Where the app sends the person. */
  url: string;
  expiresAt: string | null;
}

export interface ProviderLivenessResult {
  state: 'passed' | 'failed' | 'pending';
  confidence: number | null;
}

/** One person's KYC, for a provider that reviews it as its own submission. */
export interface ProviderKycSubmission {
  /** The provider's customer the submission is for. */
  customerId: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
  email: string;
  /** `+234...`. */
  phone: string;
  address: string;
  bvn: string;
  nin: string;
  /** A liveness session that passed, when the provider wants one. */
  livenessSessionId?: string | null;
}

export interface ProviderKycState {
  customerId: string;
  state: 'submitted' | 'approved' | 'rejected' | 'pending';
}

// ---------------------------------------------------------------------------
// Customers and their wallets
// ---------------------------------------------------------------------------

/**
 * The provider's ids for one person's wallet. Not interchangeable:
 * `customerId` names the person at the provider (history, bank sends),
 * `walletId` the account whose balance is read, `accountNumber` the NUBAN
 * people send to.
 */
export interface ProviderCustomer {
  customerId: string;
  walletId: string;
  accountNumber: string;
  /** The account's name, or '' when the provider gave none. */
  accountName: string;
}

/**
 * Turns the BVN on a provider's customer record into WAWU's keyed digest.
 * An adapter hands the BVN only to this function and never returns, stores
 * or logs it.
 */
export type ProviderBvnDigest = (bvn: string) => string;

/** A customer record and the digest of the BVN it holds (null: none readable). */
export interface ProviderCustomerMatch {
  customer: ProviderCustomer;
  bvnDigest: string | null;
}

/**
 * A customer looked up by phone: three answers. `absent` is only the
 * provider's own "no such customer"; an answer without a customer is
 * `unknown`, never absent.
 */
export type ProviderCustomerLookup =
  | ({ state: 'found' } & ProviderCustomerMatch)
  | { state: 'absent' }
  | { state: 'unknown'; why: 'empty_answer' };

/** One row of the provider's customer list: whose phone, and when made. */
export interface ProviderCustomerSighting {
  customerId: string;
  /** Local `0...` form, or null. */
  phone: string | null;
  /** ISO 8601, or null. */
  createdAt: string | null;
}

export interface ProviderOpenWalletInput {
  firstName: string;
  lastName: string;
  /** Any common Nigerian mobile form. */
  phone: string;
  email: string;
  address: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
  bvn: string;
  nin: string;
}

/**
 * What opening answered: the account (Fintava answers it at once), or a
 * customer whose account number comes later (Nuvion provisions it
 * asynchronously; `getWalletAccount` reads it when it is ready).
 */
export type ProviderOpenedWallet =
  | { state: 'open'; customer: ProviderCustomer }
  | { state: 'provisioning'; customerId: string; walletId: string | null };

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface ProviderBalance {
  /** What can be spent. The only figure a person is shown. */
  availableKobo: bigint;
  /** Including what is pending settlement. */
  bookedKobo: bigint;
}

/** WAWU's own account at the provider (its merchant or operational account). */
export interface ProviderPlatformAccount extends ProviderBalance {
  accountNumber: string;
  accountName: string;
}

// ---------------------------------------------------------------------------
// Banks
// ---------------------------------------------------------------------------

export interface ProviderBank {
  /** The code a send and a name check take; a string, the key. */
  code: string;
  name: string;
}

export interface ProviderAccountNameInput {
  accountNumber: string;
  bankCode: string;
}

export interface ProviderAccountName {
  /** True only when the bank confirmed the account. */
  matched: boolean;
  accountName: string | null;
  accountNumber: string;
  bankCode: string;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Whose transactions: WAWU's own account, or one person's. */
export type ProviderHolder =
  { kind: 'merchant' } | { kind: 'customer'; customerId: string };

export type ProviderSendKind = 'wallet_to_wallet' | 'bank_transfer';

/**
 * One transaction as the provider records it. References, named for what
 * they are: `ourReference` is the one WAWU sent; `providerReference` is the
 * provider's own, findable by lookup; `secondaryReference` is any other the
 * provider gives (Fintava's transfer `reference`, which a lookup cannot
 * find).
 */
export interface ProviderTransaction {
  /** The provider's transaction id. */
  id: string;
  createdAt: string;
  amountKobo: bigint;
  /** The provider's own status word, for logs and notes. */
  status: string;
  /** That word read as a ledger status; null when it is not one we know. */
  outcome: TransferStatus | null;
  ourReference: string | null;
  providerReference: string | null;
  secondaryReference: string | null;
  sessionId: string | null;
}

export interface ProviderPage<T> {
  items: T[];
  hasNextPage: boolean;
}

export interface ProviderPageQuery {
  /** From 1. */
  page: number;
  /** 1 to 100. */
  take: number;
  /** Newest first when 'DESC', where the provider can order. */
  order?: 'ASC' | 'DESC';
}

/**
 * A lookup has three answers: `found`, `absent` (the provider's own "not
 * found") and `unknown` (an answer that says neither). `unknown` never
 * counts as "safe to send again".
 */
export type ProviderLookup =
  | { state: 'found'; transaction: ProviderTransaction }
  | { state: 'absent' }
  | { state: 'unknown' };

export type ProviderUnknownWhy =
  | 'empty_lookup'
  | 'unreachable'
  | 'unrecognised'
  | 'too_soon'
  | 'history_incomplete';

/** What the provider knows about one of our sends: lookup, then history. */
export type ProviderReconciliation =
  | {
      state: 'found';
      source: 'lookup' | 'history';
      transaction: ProviderTransaction;
    }
  | { state: 'absent' }
  | { state: 'unknown'; why: ProviderUnknownWhy };

/**
 * What may be done with a send whose outcome was unknown, under the
 * provider's own rules: `settled` (never send again), `wait`,
 * `resend_same_reference`, or `resend_new_reference`. Advice only: nothing
 * in `src/money/` resends on it today.
 */
export type ProviderRetryDecision =
  | { action: 'settled'; transaction: ProviderTransaction }
  | { action: 'wait'; why: 'pending' | ProviderUnknownWhy }
  | { action: 'resend_same_reference' }
  | {
      action: 'resend_new_reference';
      why: 'failed' | 'absent';
      transaction: ProviderTransaction | null;
    };

/**
 * What the provider knows about a movement a delivery names, for the
 * ledger: found (with its second reference, when the provider has one
 * elsewhere), absent, or unknown and why.
 */
export type ProviderMovementConfirmation =
  | {
      state: 'found';
      transaction: ProviderTransaction;
      secondaryReference: string | null;
    }
  | { state: 'absent' }
  | { state: 'unknown'; why: string };

export interface ProviderConfirmLimits {
  /** Pages of the sender's history read when looking for one movement. */
  historyPages: number;
  /** Rows of that history read one by one by id. */
  byIdChecks: number;
}

// ---------------------------------------------------------------------------
// Moving money
// ---------------------------------------------------------------------------

export interface ProviderBankTransferInput {
  /** Whose money: a person's (their customerId) or WAWU's own account. */
  from: ProviderHolder;
  accountNumber: string;
  accountName?: string;
  bankCode: string;
  amountKobo: bigint;
  /** Ours, always: the idempotency key at the provider. */
  reference: string;
  narration?: string;
}

export interface ProviderWalletTransferInput {
  fromAccountNumber: string;
  toAccountNumber: string;
  amountKobo: bigint;
  /** Ours, always. */
  reference: string;
  narration?: string;
}

/** What the provider answered for an accepted send. */
export interface ProviderTransferReceipt {
  ourReference: string;
  providerReference: string | null;
  secondaryReference: string | null;
  transactionId: string | null;
  amountKobo: bigint;
  totalKobo: bigint;
  feeKobo: bigint;
  /** The sender's balance after, when the answer carries it. */
  sourceAvailableKobo: bigint | null;
}

// ---------------------------------------------------------------------------
// Stored webhook deliveries, read for the ledger
// ---------------------------------------------------------------------------

/**
 * Where a party's account is, as the delivery defines it:
 * - `provider_wallet`: a wallet at the provider;
 * - `bank_account`: an account at a bank, named with that bank's code. A
 *   NUBAN is unique only within its bank, so this is a WAWU wallet only
 *   when the bank is the provider's own (`walletBankCode`);
 * - `merchant`: WAWU's own account by definition.
 */
export type LedgerPartyWhere = 'provider_wallet' | 'bank_account' | 'merchant';

/** One party to a movement, as a delivery names it. */
export interface LedgerParty {
  where: LedgerPartyWhere;
  /** Every account number the delivery gives for this party, in order. */
  accountNumbers: string[];
  /** The provider's customerId, when the delivery names one. */
  customerId: string | null;
  name: string | null;
  /** The bank's code, for a `bank_account`. */
  bankCode: string | null;
}

/**
 * A movement a delivery reports. Its figures are kobo as safe integer
 * numbers (what the ledger takes), checked by the reader.
 */
export interface LedgerWebhookMovement {
  kind: 'movement';
  /** The provider's event name. */
  event: string;
  /** null: the delivery reported no status we know. */
  status: TransferStatus | null;
  amountKobo: number;
  feeKobo: number;
  totalKobo: number;
  /** Every reference field the delivery carried (meaning unconfirmed). */
  references: string[];
  sessionId: string | null;
  from: LedgerParty | null;
  to: LedgerParty | null;
  category: TransactionCategory;
  narration: string | null;
  /** True when nothing else can confirm the delivery: it is the record. */
  trustAlone: boolean;
}

export interface LedgerWebhookReversal {
  kind: 'reversal';
  status: TransferStatus | null;
  /** References that may name the reversed debit. */
  references: string[];
  reversalReference: string | null;
  customerId: string | null;
  amountKobo: number | null;
  chargesKobo: number | null;
  totalKobo: number | null;
}

export interface LedgerWebhookUnreadable {
  kind: 'unreadable';
  why: string;
}

export type LedgerWebhookReading =
  LedgerWebhookMovement | LedgerWebhookReversal | LedgerWebhookUnreadable;

/** How the ledger reads the provider's stored deliveries. */
export interface ProviderDeliveries {
  /** The event names whose deliveries the ledger reads. */
  readonly ledgerEvents: readonly string[];
  /** Reads one stored delivery. Never throws: unreadable says why. */
  read(
    event: string,
    payload: unknown,
    eventReference: string,
  ): LedgerWebhookReading;
}

// ---------------------------------------------------------------------------
// The interfaces
// ---------------------------------------------------------------------------

/**
 * Everything `src/money/` asks of the company that holds the wallets. Every
 * method fails with a `WalletProviderError` (wallet-provider-error.ts);
 * anything else thrown is a bug, passed through.
 */
export interface WalletProvider {
  readonly name: WalletProviderName;
  /** The provider's name as notes and logs print it ("Fintava"). */
  readonly label: string;
  /**
   * False when the provider is not set up on this server (production before
   * its keys arrive): nothing is sent and wallet routes answer 503.
   */
  readonly configured: boolean;
  readonly timings: WalletProviderTimings;
  readonly capabilities: WalletProviderCapabilities;
  /**
   * The bank code of every wallet at this provider: a party named at a bank
   * is a WAWU wallet only at this bank.
   */
  readonly walletBankCode: string;
  readonly deliveries: ProviderDeliveries;

  // Identity
  /** A BVN check (charged by the provider, even when it fails). */
  checkIdentity(bvn: string): Promise<ProviderIdentity>;
  /** A selfie matched against the BVN record's photo. */
  matchSelfie(input: ProviderSelfieInput): Promise<ProviderSelfieResult>;
  /** Starts a hosted liveness check for one customer. */
  startLivenessSession(input: {
    customerId: string;
    returnUrl?: string | null;
  }): Promise<ProviderLivenessSession>;
  getLivenessResult(sessionId: string): Promise<ProviderLivenessResult>;
  /** Sends one person's KYC for the provider's review. */
  submitKyc(input: ProviderKycSubmission): Promise<ProviderKycState>;

  // Opening
  /** Opens one person's wallet. Not idempotent at Fintava: the caller dedupes. */
  openWallet(input: ProviderOpenWalletInput): Promise<ProviderOpenedWallet>;
  /** The wallet of a customer, or null while its account number is pending. */
  getWalletAccount(customerId: string): Promise<ProviderCustomer | null>;
  findCustomerByPhone(
    phone: string,
    digest: ProviderBvnDigest,
  ): Promise<ProviderCustomerLookup>;
  getCustomerMatch(
    customerId: string,
    digest: ProviderBvnDigest,
  ): Promise<ProviderCustomerMatch>;
  listCustomerSightings(
    query: Omit<ProviderPageQuery, 'order'>,
  ): Promise<ProviderPage<ProviderCustomerSighting>>;

  // Balances
  getBalance(wallet: { walletId: string }): Promise<ProviderBalance>;
  getPlatformAccount(): Promise<ProviderPlatformAccount>;

  // Banks
  listBanks(): Promise<ProviderBank[]>;
  checkAccountName(
    input: ProviderAccountNameInput,
  ): Promise<ProviderAccountName>;

  // Moving money
  bankTransfer(
    input: ProviderBankTransferInput,
  ): Promise<ProviderTransferReceipt>;
  walletToWallet(
    input: ProviderWalletTransferInput,
  ): Promise<ProviderTransferReceipt>;

  // Transactions
  findTransactionByReference(reference: string): Promise<ProviderLookup>;
  findTransactionById(id: string): Promise<ProviderLookup>;
  listTransactions(
    holder: ProviderHolder,
    query: ProviderPageQuery,
  ): Promise<ProviderPage<ProviderTransaction>>;
  /** What the provider knows about one of our sends (lookup, then history). */
  reconcileSend(
    reference: string,
    holder: ProviderHolder,
    since?: Date,
  ): Promise<ProviderReconciliation>;
  /** The provider's rule for a send whose outcome was unknown. Pure. */
  decideRetry(
    kind: ProviderSendKind,
    reconciliation: ProviderReconciliation,
    clock: { attemptedAt: Date; now: Date; resendAfterMs: number },
  ): ProviderRetryDecision;
  /**
   * What the provider knows about a movement named by these references
   * (and, for a sender of ours, found in its history by amount and time).
   */
  confirmMovement(input: {
    references: readonly string[];
    sender: ProviderHolder | null;
    amountKobo: number;
    around: Date;
    limits: ProviderConfirmLimits;
  }): Promise<ProviderMovementConfirmation>;
  /**
   * The transaction's second reference, read from wherever the provider
   * keeps it (Fintava: the by-id record); null when there is none or the
   * provider could not say.
   */
  secondaryReferenceOf(t: ProviderTransaction): Promise<string | null>;
}

/** One PIN reset code for one person, as an `OtpSender` sends it (NUV-01). */
export interface OtpResetCode {
  /** Whose code: an email sender has WAWU ID write to this account's address. */
  wawuUserId: string;
  /** The proved phone (E.164) an SMS sender texts; null when there is none. */
  phone: string | null;
  /** The code itself. Never logged, never stored in the clear. */
  code: string;
  /** How long it lives, in whole minutes. */
  minutes: number;
  /** The whole message, for a sender that sends a text as it is (SMS). */
  text: string;
}

/**
 * Sends the PIN reset code to a person (MONEY-14). Separate from the wallet
 * provider: Nuvion has no SMS and the owner rules codes go by email (R-39),
 * so under nuvion this token is an email sender (NUV-01) and under fintava
 * Fintava's SMS.
 */
export interface OtpSender {
  readonly configured: boolean;
  /**
   * How the code reaches the person: `sms`, a text to the phone their BVN
   * check proved; `email`, an email to their account's address.
   */
  readonly channel: 'sms' | 'email';
  /**
   * Sends one text. Fails with a `WalletProviderError`: an unknown outcome
   * (`recordMayExist`) may have arrived; any other kind was not sent. An
   * email sender sends no text (`not_supported`).
   */
  sendText(phone: string, text: string): Promise<void>;
  /** Sends one PIN reset code by `channel`. Fails as `sendText` does. */
  sendResetCode(code: OtpResetCode): Promise<void>;
}
