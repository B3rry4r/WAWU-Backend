import { randomUUID } from 'node:crypto';
import type { TransferStatus } from '../../money-view.type';
import {
  type ProviderAccountName,
  type ProviderBalance,
  type ProviderBank,
  type ProviderCustomer,
  type ProviderCustomerLookup,
  type ProviderCustomerMatch,
  type ProviderCustomerSighting,
  type ProviderDeliveries,
  type ProviderHolder,
  type ProviderIdentity,
  type ProviderKycState,
  type ProviderLivenessResult,
  type ProviderLivenessSession,
  type ProviderLookup,
  type ProviderMovementConfirmation,
  type ProviderOpenedWallet,
  type ProviderPage,
  type ProviderPlatformAccount,
  type ProviderReconciliation,
  type ProviderRetryDecision,
  type ProviderSelfieResult,
  type ProviderSendKind,
  type ProviderTransaction,
  type ProviderTransferReceipt,
  type ProviderWalletTransferInput,
  type WalletProvider,
  type WalletProviderCapabilities,
  type WalletProviderTimings,
} from '../../../wallet-provider/wallet-provider.interface';
import {
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../../wallet-provider/wallet-provider-error';

/**
 * Nuvion, stood in at the wallet provider seam (task MONEY-17, 8 Oct 2026).
 *
 * The Nuvion sandbox key does not work yet (SANDBOX-FINDINGS, 7 Oct: 401),
 * and NUV-01's HTTP stand-in and NUV-05's book transfers are being built
 * beside this task. So this is a `WalletProvider` that behaves the way
 * Nuvion's documented API does for the calls a wallet payment makes, mapped
 * onto the seam the way an adapter honouring the seam must map it. It is a
 * test double: no host is called, nothing is real money.
 *
 * What it models, from Nuvion's docs (lead's scratchpad `nuvion/docs/`):
 * - **Accounts** (`core-concepts__accounts.md`, `api-reference__accounts.md`):
 *   each person is a child entity with an NGN `checking` account (ULID id, a
 *   `nuvion_ban`, a 10-digit NGN account number); WAWU's parent entity holds
 *   an `operational` account. Balances are integers in the smallest unit;
 *   `balance.available` is what can be spent.
 * - **Book transfers** (`guides__send-a-payout.md`, "Nuvion Direct", and
 *   `api-reference__transfers.md`; SANDBOX-FINDINGS item 9): `POST
 *   /transfers` with `payment_type: book-transfer`, the payer's `entity_id`
 *   and `account_id`, the receiver's `nuvion_ban`, `currency: NGN`,
 *   `unique_reference` (required, at most 64 characters: a second transfer
 *   with the same reference for the account returns the original, never a
 *   second one), `narration` (required, at most 100 characters). The fee
 *   (`applicable_fee`) is charged on top of the amount. Every transfer is
 *   asynchronous: the answer says `pending`, `processing`, `successful`,
 *   `failed` or `reversed`; book transfers are "Instant", so a payment can
 *   be `successful` in the answer, or still `pending` and settled later.
 * - **Errors** (`errors.md`): `error_transfer_insufficient_funds` (400),
 *   `error_transfer_account_not_active` (400), `error_transfer_compliance_
 *   rejected` (422), `error_transfer_network_unavailable` (503),
 *   `error_idempotency_request_processing` (409), `error_auth_credentials_
 *   invalid` (401), `error_auth_rate_limit_exceeded` (429), a timeout and a
 *   bare 5xx. Each becomes one `WalletProviderError` kind below
 *   (`NUVION_ERROR_KINDS`): this double's mapping, until NUV-01 builds the
 *   real one.
 * - **No lookup by our reference** (NUVION-RESEARCH section 7): the adapter
 *   keeps Nuvion's transfer id for each reference (NUV-05), and
 *   `reconcileSend` answers from it.
 *
 * How it sits on the seam (the contract MONEY-17 relies on; SHARED-CHANGES
 * row for the seam's wording): `walletToWallet` resolves with a receipt only
 * for a transfer Nuvion reports `successful`; a transfer Nuvion accepted and
 * has not completed (`pending`, `processing`) is `not_confirmed` with
 * `recordMayExist`, because the money may move; a lost answer is
 * `outcome_unknown`. Nothing else in the interface would let the payment
 * tell "queued" from "moved".
 */

/** A Nuvion account as the double keeps it. */
export interface NuvionAccount {
  entityId: string;
  /** The account's ULID: what the seam calls `walletId`. */
  accountId: string;
  /** Nuvion's internal routing number, the book transfer's receiver. */
  nuvionBan: string;
  /** The NGN account number people send to (null for the operational one). */
  accountNumber: string | null;
  type: 'checking' | 'operational';
  currency: 'NGN';
  availableKobo: bigint;
}

/** One `POST /transfers` the adapter would send, as Nuvion receives it. */
export interface NuvionBookTransferRequest {
  entity_id: string;
  account_id: string;
  amount: number;
  currency: string;
  payment_type: 'book-transfer';
  nuvion_ban: string;
  unique_reference: string;
  narration: string;
}

/** A transfer as Nuvion records it. */
export interface NuvionTransfer {
  id: string;
  request: NuvionBookTransferRequest;
  fromAccountId: string;
  toAccountId: string;
  amountKobo: bigint;
  feeKobo: bigint;
  status: 'pending' | 'processing' | 'successful' | 'failed' | 'reversed';
  statusReason: string;
  created: number;
}

/** What the double does with the next book transfer. */
export type NuvionSendMode =
  /** Book transfers are instant: `successful` in the answer. */
  | 'instant'
  /** Accepted and `pending` in the answer; `settle()` finishes it. */
  | 'queued'
  /** The money moves and the answer is lost (a timeout). */
  | 'timeout'
  /** Nothing moves and the answer is lost (a timeout before Nuvion took it). */
  | 'timeout_nothing'
  /** A bare 500 after Nuvion took the transfer. */
  | 'error500'
  | 'insufficient'
  | 'account_not_active'
  | 'compliance_rejected'
  | 'network_unavailable'
  | 'request_processing'
  | 'auth'
  | 'rate_limited'
  /** Nuvion moves another amount than asked (a stop for review). */
  | 'wrong_amount'
  /** The adapter's book area not built yet (NUV-01 before NUV-05). */
  | 'not_supported';

/** Nuvion's error types, as this double maps them onto the seam. */
export const NUVION_ERROR_KINDS: Record<
  string,
  {
    kind: WalletProviderErrorKind;
    httpStatus: number | null;
    mayExist: boolean;
  }
> = {
  error_transfer_insufficient_funds: {
    kind: 'insufficient_funds',
    httpStatus: 400,
    mayExist: false,
  },
  error_transfer_account_not_active: {
    kind: 'wallet_inactive',
    httpStatus: 400,
    mayExist: false,
  },
  error_transfer_compliance_rejected: {
    kind: 'refused',
    httpStatus: 422,
    mayExist: false,
  },
  error_transfer_network_unavailable: {
    kind: 'unavailable',
    httpStatus: 503,
    mayExist: false,
  },
  error_idempotency_request_processing: {
    kind: 'outcome_unknown',
    httpStatus: 409,
    mayExist: true,
  },
  error_auth_credentials_invalid: {
    kind: 'auth',
    httpStatus: 401,
    mayExist: false,
  },
  error_auth_rate_limit_exceeded: {
    kind: 'rate_limited',
    httpStatus: 429,
    mayExist: false,
  },
  /** A timeout or a 5xx on a write: the transfer may exist. */
  lost_answer: { kind: 'outcome_unknown', httpStatus: null, mayExist: true },
  /** Accepted, not completed yet. */
  accepted_pending: {
    kind: 'not_confirmed',
    httpStatus: 201,
    mayExist: true,
  },
};

/** Nuvion's transfer status read as a ledger status (null: none we know). */
export function nuvionOutcome(status: string): TransferStatus | null {
  switch (status) {
    case 'successful':
      return 'completed';
    case 'pending':
    case 'processing':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return null;
  }
}

/** A ULID-shaped id (26 Crockford characters), as Nuvion's ids are. */
function ulid(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const hex = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  let out = '01';
  for (let i = 0; out.length < 26; i += 1) {
    out += alphabet[parseInt(hex[i], 16) % alphabet.length];
  }
  return out;
}

export class NuvionSeamStandIn implements WalletProvider {
  readonly name = 'nuvion' as const;
  readonly label = 'Nuvion';
  readonly configured = true;
  readonly timings: WalletProviderTimings;
  /** NUV-01's capabilities for Nuvion (no BVN lookup, KYC its own submission). */
  readonly capabilities: WalletProviderCapabilities = {
    selfieMatch: false,
    hostedLiveness: false,
    separateKyc: true,
    asyncAccountNumber: true,
    identityLookup: false,
  };
  readonly walletBankCode = 'nuvion_ban';
  readonly deliveries: ProviderDeliveries = {
    ledgerEvents: [],
    read: () => ({ kind: 'unreadable', why: 'not modelled by the stand-in' }),
  };

  /** accountId to account. */
  readonly accounts = new Map<string, NuvionAccount>();
  /** Every transfer Nuvion recorded, in order. */
  readonly transfers: NuvionTransfer[] = [];
  /** Every call the payment code made, by method name. */
  readonly calls: Array<{ method: string; args: unknown }> = [];
  /** What the next book transfers do. */
  mode: NuvionSendMode = 'instant';
  /** Nuvion's `applicable_fee` on a book transfer: its fee settings (NUV-07). */
  feeKobo: (amountKobo: bigint) => bigint = () => 0n;
  /** References whose record the adapter cannot read yet (Nuvion lagging). */
  readonly unseen = new Set<string>();
  /** WAWU's operational account. */
  readonly operational: NuvionAccount;
  /** The answer `getPlatformAccount` gives instead of the operational account. */
  platformOverride: ProviderPlatformAccount | null = null;

  constructor(timings: Partial<WalletProviderTimings> = {}) {
    this.timings = {
      readTimeoutMs: 1_500,
      moneyTimeoutMs: 1_500,
      checkTimeoutMs: 1_500,
      resendSafetyMs: 1_000,
      retryAfterSeconds: 30,
      ...timings,
    };
    this.operational = {
      entityId: ulid(),
      accountId: ulid(),
      // The docs' own example of a nuvion_ban that is not ten digits.
      nuvionBan: 'NVXYT1GUCM',
      accountNumber: null,
      type: 'operational',
      currency: 'NGN',
      availableKobo: 0n,
    };
    this.accounts.set(this.operational.accountId, this.operational);
  }

  /** A person's approved entity and NGN checking account holding `kobo`. */
  openAccount(kobo: bigint, accountNumber: string): NuvionAccount {
    const a: NuvionAccount = {
      entityId: ulid(),
      accountId: ulid(),
      nuvionBan: `00${accountNumber.slice(-8)}`,
      accountNumber,
      type: 'checking',
      currency: 'NGN',
      availableKobo: kobo,
    };
    this.accounts.set(a.accountId, a);
    return a;
  }

  /** Finishes a queued transfer the way Nuvion's processing would. */
  settle(reference: string, status: 'successful' | 'failed'): void {
    const t = this.transfers.find(
      (x) => x.request.unique_reference === reference,
    );
    if (!t || (t.status !== 'pending' && t.status !== 'processing')) {
      throw new Error(`stand-in: no queued transfer ${reference}`);
    }
    if (status === 'successful') {
      this.move(t);
      t.statusReason = 'completed';
    } else {
      t.statusReason = 'compliance_hold';
    }
    t.status = status;
  }

  sendsFrom(accountId: string): NuvionTransfer[] {
    return this.transfers.filter((t) => t.fromAccountId === accountId);
  }

  private move(t: NuvionTransfer): void {
    const from = this.accounts.get(t.fromAccountId)!;
    const to = this.accounts.get(t.toAccountId)!;
    from.availableKobo -= t.amountKobo + t.feeKobo;
    to.availableKobo += t.amountKobo;
  }

  private error(
    type: keyof typeof NUVION_ERROR_KINDS,
    operation: string,
    reference: string | null = null,
  ): WalletProviderError {
    const e = NUVION_ERROR_KINDS[type];
    return new WalletProviderError({
      kind: e.kind,
      provider: 'nuvion',
      operation,
      httpStatus: e.httpStatus,
      messages: [type],
      reference,
      recordMayExist: e.mayExist,
      retryAfterSeconds: this.timings.retryAfterSeconds,
    });
  }

  private notSupported(operation: string): WalletProviderError {
    return new WalletProviderError({
      kind: 'not_supported',
      provider: 'nuvion',
      operation,
      retryAfterSeconds: this.timings.retryAfterSeconds,
    });
  }

  private byAccountNumber(accountNumber: string): NuvionAccount | null {
    for (const a of this.accounts.values()) {
      if (a.accountNumber === accountNumber) return a;
    }
    return null;
  }

  private byBan(ban: string): NuvionAccount | null {
    for (const a of this.accounts.values()) {
      if (a.nuvionBan === ban) return a;
    }
    return null;
  }

  private transaction(t: NuvionTransfer): ProviderTransaction {
    return {
      id: t.id,
      createdAt: new Date(t.created).toISOString(),
      amountKobo: t.amountKobo,
      status: t.status,
      outcome: nuvionOutcome(t.status),
      ourReference: t.request.unique_reference,
      providerReference: t.id,
      secondaryReference: null,
      sessionId: null,
    };
  }

  // -------------------------------------------------------------------------
  // What a wallet payment calls
  // -------------------------------------------------------------------------

  getBalance(wallet: { walletId: string }): Promise<ProviderBalance> {
    this.calls.push({ method: 'getBalance', args: wallet });
    const a = this.accounts.get(wallet.walletId);
    if (!a) return Promise.reject(this.error('lost_answer', 'balance'));
    return Promise.resolve({
      availableKobo: a.availableKobo,
      bookedKobo: a.availableKobo,
    });
  }

  getPlatformAccount(): Promise<ProviderPlatformAccount> {
    this.calls.push({ method: 'getPlatformAccount', args: null });
    if (this.mode === 'not_supported') {
      return Promise.reject(this.notSupported('operational account'));
    }
    if (this.platformOverride) return Promise.resolve(this.platformOverride);
    return Promise.resolve({
      accountNumber: this.operational.nuvionBan,
      accountName: 'WAWU Operational',
      availableKobo: this.operational.availableKobo,
      bookedKobo: this.operational.availableKobo,
    });
  }

  async walletToWallet(
    input: ProviderWalletTransferInput,
  ): Promise<ProviderTransferReceipt> {
    this.calls.push({ method: 'walletToWallet', args: input });
    // The network round trip the real adapter makes.
    await Promise.resolve();
    const op = 'book transfer';
    if (this.mode === 'not_supported') throw this.notSupported(op);
    const from = this.byAccountNumber(input.fromAccountNumber);
    const to = this.byBan(input.toAccountNumber);
    if (!from || !to) {
      throw new WalletProviderError({
        kind: 'not_found',
        provider: 'nuvion',
        operation: op,
        httpStatus: 404,
        reference: input.reference,
        recordMayExist: false,
      });
    }
    const request: NuvionBookTransferRequest = {
      entity_id: from.entityId,
      account_id: from.accountId,
      amount: Number(input.amountKobo),
      currency: from.currency,
      payment_type: 'book-transfer',
      nuvion_ban: to.nuvionBan,
      unique_reference: input.reference,
      narration: input.narration ?? '',
    };
    if (
      request.unique_reference.length < 1 ||
      request.unique_reference.length > 64 ||
      request.narration.length < 1 ||
      request.narration.length > 100 ||
      !Number.isSafeInteger(request.amount) ||
      request.amount < 1
    ) {
      throw new WalletProviderError({
        kind: 'validation',
        provider: 'nuvion',
        operation: op,
        httpStatus: 422,
        reference: input.reference,
        recordMayExist: false,
      });
    }
    // The same unique_reference for the account answers the original
    // transfer (Nuvion's 409), never a second one.
    const original = this.transfers.find(
      (t) =>
        t.fromAccountId === from.accountId &&
        t.request.unique_reference === input.reference,
    );
    if (original) return this.answerFor(original, op);

    const mode = this.mode;
    const refusals: Partial<Record<NuvionSendMode, string>> = {
      insufficient: 'error_transfer_insufficient_funds',
      account_not_active: 'error_transfer_account_not_active',
      compliance_rejected: 'error_transfer_compliance_rejected',
      network_unavailable: 'error_transfer_network_unavailable',
      request_processing: 'error_idempotency_request_processing',
      auth: 'error_auth_credentials_invalid',
      rate_limited: 'error_auth_rate_limit_exceeded',
    };
    const refusal = refusals[mode];
    if (refusal) throw this.error(refusal, op, input.reference);
    if (mode === 'timeout_nothing') {
      throw this.error('lost_answer', op, input.reference);
    }
    const amountKobo = input.amountKobo + (mode === 'wrong_amount' ? 100n : 0n);
    const feeKobo = this.feeKobo(input.amountKobo);
    if (from.availableKobo < amountKobo + feeKobo) {
      throw this.error(
        'error_transfer_insufficient_funds',
        op,
        input.reference,
      );
    }
    const t: NuvionTransfer = {
      id: ulid(),
      request,
      fromAccountId: from.accountId,
      toAccountId: to.accountId,
      amountKobo,
      feeKobo,
      status: mode === 'queued' ? 'pending' : 'successful',
      statusReason: mode === 'queued' ? 'awaiting_processing' : 'completed',
      created: Date.now(),
    };
    this.transfers.push(t);
    if (t.status === 'successful') this.move(t);
    if (mode === 'timeout' || mode === 'error500') {
      // Nuvion took it; the answer never reached us.
      throw this.error('lost_answer', op, input.reference);
    }
    return this.answerFor(t, op);
  }

  /** The seam's answer for a transfer Nuvion holds: a receipt only once it moved. */
  private answerFor(t: NuvionTransfer, op: string): ProviderTransferReceipt {
    if (t.status === 'pending' || t.status === 'processing') {
      throw this.error('accepted_pending', op, t.request.unique_reference);
    }
    if (t.status !== 'successful') {
      throw new WalletProviderError({
        kind: 'refused',
        provider: 'nuvion',
        operation: op,
        httpStatus: 200,
        messages: [t.statusReason],
        reference: t.request.unique_reference,
        recordMayExist: false,
      });
    }
    const from = this.accounts.get(t.fromAccountId)!;
    return {
      ourReference: t.request.unique_reference,
      providerReference: t.id,
      secondaryReference: null,
      transactionId: t.id,
      amountKobo: t.amountKobo,
      feeKobo: t.feeKobo,
      totalKobo: t.amountKobo + t.feeKobo,
      sourceAvailableKobo: from.availableKobo,
    };
  }

  reconcileSend(
    reference: string,
    holder: ProviderHolder,
    since?: Date,
  ): Promise<ProviderReconciliation> {
    this.calls.push({
      method: 'reconcileSend',
      args: { reference, holder, since },
    });
    if (this.unseen.has(reference)) {
      return Promise.resolve({ state: 'unknown', why: 'too_soon' });
    }
    const t = this.transfers.find(
      (x) => x.request.unique_reference === reference,
    );
    if (!t) return Promise.resolve({ state: 'absent' });
    return Promise.resolve({
      state: 'found',
      source: 'lookup',
      transaction: this.transaction(t),
    });
  }

  findTransactionByReference(reference: string): Promise<ProviderLookup> {
    this.calls.push({ method: 'findTransactionByReference', args: reference });
    const t = this.transfers.find(
      (x) => x.request.unique_reference === reference,
    );
    return Promise.resolve(
      t
        ? { state: 'found', transaction: this.transaction(t) }
        : { state: 'absent' },
    );
  }

  findTransactionById(id: string): Promise<ProviderLookup> {
    this.calls.push({ method: 'findTransactionById', args: id });
    const t = this.transfers.find((x) => x.id === id);
    return Promise.resolve(
      t
        ? { state: 'found', transaction: this.transaction(t) }
        : { state: 'absent' },
    );
  }

  decideRetry(
    _kind: ProviderSendKind,
    r: ProviderReconciliation,
  ): ProviderRetryDecision {
    if (r.state === 'found' && r.transaction.outcome === 'completed') {
      return { action: 'settled', transaction: r.transaction };
    }
    return { action: 'wait', why: r.state === 'unknown' ? r.why : 'pending' };
  }

  secondaryReferenceOf(): Promise<string | null> {
    return Promise.resolve(null);
  }

  // -------------------------------------------------------------------------
  // Not called by a wallet payment: other tasks' areas (NUV-02 to NUV-08)
  // -------------------------------------------------------------------------

  checkIdentity(): Promise<ProviderIdentity> {
    return Promise.reject(this.notSupported('identity check'));
  }
  matchSelfie(): Promise<ProviderSelfieResult> {
    return Promise.reject(this.notSupported('selfie match'));
  }
  startLivenessSession(): Promise<ProviderLivenessSession> {
    return Promise.reject(this.notSupported('liveness session'));
  }
  getLivenessResult(): Promise<ProviderLivenessResult> {
    return Promise.reject(this.notSupported('liveness result'));
  }
  submitKyc(): Promise<ProviderKycState> {
    return Promise.reject(this.notSupported('kyc submission'));
  }
  openWallet(): Promise<ProviderOpenedWallet> {
    return Promise.reject(this.notSupported('open wallet'));
  }
  getWalletAccount(): Promise<ProviderCustomer | null> {
    return Promise.reject(this.notSupported('wallet account'));
  }
  findCustomerByPhone(): Promise<ProviderCustomerLookup> {
    return Promise.reject(this.notSupported('customer by phone'));
  }
  getCustomerMatch(): Promise<ProviderCustomerMatch> {
    return Promise.reject(this.notSupported('customer match'));
  }
  listCustomerSightings(): Promise<ProviderPage<ProviderCustomerSighting>> {
    return Promise.reject(this.notSupported('customer list'));
  }
  listBanks(): Promise<ProviderBank[]> {
    return Promise.reject(this.notSupported('bank list'));
  }
  checkAccountName(): Promise<ProviderAccountName> {
    return Promise.reject(this.notSupported('account name'));
  }
  bankTransfer(): Promise<ProviderTransferReceipt> {
    return Promise.reject(this.notSupported('bank transfer'));
  }
  listTransactions(): Promise<ProviderPage<ProviderTransaction>> {
    return Promise.reject(this.notSupported('transactions'));
  }
  confirmMovement(): Promise<ProviderMovementConfirmation> {
    return Promise.reject(this.notSupported('confirm movement'));
  }
}
