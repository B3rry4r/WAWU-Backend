import { randomUUID } from 'node:crypto';
import type { TransferStatus } from '../../src/money/money-view.type';
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
} from '../../src/wallet-provider/wallet-provider.interface';
import {
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../src/wallet-provider/wallet-provider-error';
import { providerLimitError } from '../../src/wallet-provider/wallet-provider-limit';

/**
 * Nuvion, stood in at the wallet provider seam (task MONEY-17; rounds 5 and
 * 6, 8 Oct 2026).
 *
 * The Nuvion sandbox key does not work yet (SANDBOX-FINDINGS, 7 Oct: 401),
 * and NUV-05's book transfers are being built beside this task. So this is a
 * `WalletProvider` that behaves the way Nuvion's PUBLIC DOCS say its API
 * does for the calls a wallet payment makes (lead ruling 4: the docs, not
 * the dashboard code), mapped onto the seam the way an adapter honouring the
 * seam must map it. A test double: no host is called, nothing is real money.
 *
 * From Nuvion's docs (lead's scratchpad `nuvion/docs/`):
 * - **Accounts** (`core-concepts__accounts.md`, `api-reference__accounts.md`):
 *   each person is a child entity with an NGN `checking` account (an id, a
 *   `nuvion_ban`, a 10-digit NGN account number); WAWU's parent entity holds
 *   an `operational` account. Integers in the smallest unit; `available` is
 *   what can be spent. An outflow is taken from `available` when Nuvion
 *   accepts it and given back if it fails or is cancelled (the docs leave
 *   this open; holding it is the reading that never lets one balance pay
 *   twice).
 * - **Transfers** (`api-reference__transfers.md`): "All transfers are
 *   asynchronous: the response reflects the initial queued state". The
 *   create answer is `pending` (the default here, `mode: 'pending'`), then
 *   `processing`, `successful`, `failed`, `reversed`; `outflows.cancelled`
 *   (`webhooks__event-types.md`) is a transfer that will not be made. A
 *   second create with the same `unique_reference` for the account answers
 *   `409` with the original transfer; the same reference with other
 *   parameters is `409 error_idempotency_key_mismatch`. `applicable_fee` is
 *   charged on top of the amount. `unique_reference` at most 64 characters,
 *   `narration` required, at most 100.
 * - **No lookup by our reference** (NUVION-RESEARCH section 7): the adapter
 *   keeps Nuvion's transfer id from every answer it read (`keptIds`) and
 *   looks a transfer up by that id (`GET /transfers/{id}`). When the answer
 *   was lost it has no id, so it walks the payer's transfers (`GET
 *   /transfers?entity_id=&account_id=`, each item carrying its
 *   `unique_reference`): a `history` sighting.
 * - **Errors** (`errors.md`), mapped by `type`, never by HTTP status (the
 *   insufficient-funds answer is 400 on the errors page and 422 on the
 *   transfers page): see `NUVION_ERROR_KINDS`. The three limit errors go
 *   through NUV-07's `providerLimitError`, so they answer `limit_reached`.
 *   A system error (500, 503, 504) or a timeout on a create says nothing
 *   about whether the transfer exists: `outcome_unknown`, money may move.
 *
 * On the seam (the contract MONEY-17 relies on; SHARED-CHANGES MONEY-17 #1):
 * `walletToWallet` resolves with a receipt only for a transfer Nuvion
 * reports `successful`; one it accepted and has not finished (`pending`,
 * `processing`) is `not_confirmed`, a repeated reference
 * `duplicate_reference`, a lost answer `outcome_unknown`: each may have
 * moved money (`recordMayExist`), so the payment stays pending and settles
 * from Nuvion's later answer. `isSameAccount` knows one account by its NGN
 * account number, its id and its `nuvion_ban` (lead ruling R5-1).
 */

/** A Nuvion account as the double keeps it. */
export interface NuvionAccount {
  entityId: string;
  /** The account's id: what the seam calls `walletId`. */
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

/**
 * A transfer's status as Nuvion words it: `pending`, `processing`,
 * `successful`, `failed`, `cancelled`, `reversed`, or any other word Nuvion
 * might send (read as unknown).
 */
export type NuvionTransferStatus = string;

/** A transfer as Nuvion records it. */
export interface NuvionTransfer {
  id: string;
  request: NuvionBookTransferRequest;
  fromAccountId: string;
  toAccountId: string;
  amountKobo: bigint;
  feeKobo: bigint;
  status: NuvionTransferStatus;
  statusReason: string;
  created: number;
}

/** What Nuvion does with the next book transfer. */
export type NuvionSendMode =
  /** Accepted; the answer says `pending` (Nuvion's documented first answer). */
  | 'pending'
  /** Accepted; the answer says `processing`. */
  | 'processing'
  /** Accepted and `successful` in the answer (book transfers are "Instant"). */
  | 'successful'
  /** Nuvion takes the transfer; the answer never arrives (a timeout). */
  | 'timeout'
  /** Nothing is taken and the answer never arrives. */
  | 'timeout_nothing'
  /** A system or rail error answered on the create (`systemError` says which). */
  | 'system_error'
  /** `error_transfer_already_processing` (409). */
  | 'already_processing'
  /** `error_idempotency_request_processing` (409). */
  | 'request_processing'
  /** `error_transfer_insufficient_funds`, whatever Nuvion's balance says. */
  | 'insufficient'
  | 'account_not_active'
  | 'compliance_rejected'
  | 'auth'
  | 'rate_limited'
  /** One of Nuvion's three limit errors (`limitError` says which). */
  | 'limit'
  /** The adapter's book area not built yet (NUV-01 before NUV-05). */
  | 'not_supported';

/** A system error on a create: its type, HTTP status, and whether Nuvion made the transfer anyway. */
export interface NuvionSystemError {
  type:
    | 'error_system_internal_error'
    | 'error_system_service_unavailable'
    | 'error_system_dependency_unavailable'
    | 'error_system_timeout'
    | 'error_transfer_network_unavailable';
  httpStatus: 500 | 503 | 504;
  created: boolean;
}

/** Nuvion's error types, as this double maps them onto the seam (by type, never by status). */
export const NUVION_ERROR_KINDS: Record<
  string,
  { kind: WalletProviderErrorKind; mayExist: boolean }
> = {
  error_transfer_insufficient_funds: {
    kind: 'insufficient_funds',
    mayExist: false,
  },
  error_transfer_account_not_active: {
    kind: 'wallet_inactive',
    mayExist: false,
  },
  error_transfer_compliance_rejected: { kind: 'refused', mayExist: false },
  error_auth_credentials_invalid: { kind: 'auth', mayExist: false },
  error_auth_rate_limit_exceeded: { kind: 'rate_limited', mayExist: false },
  // Nuvion may already hold the transfer: never read as "nothing moved".
  error_transfer_already_processing: {
    kind: 'outcome_unknown',
    mayExist: true,
  },
  error_idempotency_request_processing: {
    kind: 'outcome_unknown',
    mayExist: true,
  },
  error_idempotency_key_mismatch: {
    kind: 'duplicate_reference',
    mayExist: true,
  },
  error_system_internal_error: { kind: 'outcome_unknown', mayExist: true },
  error_system_service_unavailable: {
    kind: 'outcome_unknown',
    mayExist: true,
  },
  error_system_dependency_unavailable: {
    kind: 'outcome_unknown',
    mayExist: true,
  },
  error_system_timeout: { kind: 'outcome_unknown', mayExist: true },
  error_transfer_network_unavailable: {
    kind: 'outcome_unknown',
    mayExist: true,
  },
  /** A timeout before any answer. */
  lost_answer: { kind: 'outcome_unknown', mayExist: true },
  /** A `409` with the original transfer: the reference was used before. */
  duplicate_original: { kind: 'duplicate_reference', mayExist: true },
  /** Accepted, not finished yet (`pending`, `processing`). */
  accepted_unfinished: { kind: 'not_confirmed', mayExist: true },
};

/** Nuvion's transfer status read as a ledger status (null: a word we do not know). */
export function nuvionOutcome(status: string): TransferStatus | null {
  switch (status) {
    case 'successful':
      return 'completed';
    case 'pending':
    case 'processing':
      return 'pending';
    // A cancelled transfer is one Nuvion will not make (`outflows.cancelled`).
    case 'failed':
    case 'cancelled':
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
  for (let i = 0; out.length < 26; i += 2) {
    out += alphabet[parseInt(hex.slice(i, i + 2), 16) % alphabet.length];
  }
  return out;
}

const UNFINISHED = new Set(['pending', 'processing']);

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
  /**
   * Our reference to Nuvion's transfer id, for every create answer the
   * adapter READ (a lost answer leaves none): what the adapter stores,
   * since Nuvion has no lookup by our reference.
   */
  readonly keptIds = new Map<string, string>();
  /** What the next book transfers do. */
  mode: NuvionSendMode = 'pending';
  /** For `mode: 'system_error'`. */
  systemError: NuvionSystemError = {
    type: 'error_system_internal_error',
    httpStatus: 500,
    created: false,
  };
  /** For `mode: 'limit'`. */
  limitError:
    | 'error_transfer_transaction_limit_exceeded'
    | 'error_transfer_daily_limit_exceeded'
    | 'error_transfer_monthly_volume_exceeded' =
    'error_transfer_daily_limit_exceeded';
  /** The HTTP status Nuvion answers insufficient funds with (400 or 422: mapped by type). */
  insufficientStatus: 400 | 422 = 422;
  /** Added to what Nuvion moves (another amount than asked: a stop for review). */
  extraKobo = 0n;
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

  /** Moves a transfer Nuvion holds to its next status, as Nuvion's processing would. */
  settle(reference: string, status: NuvionTransferStatus): void {
    const t = this.transfers.find(
      (x) => x.request.unique_reference === reference,
    );
    if (!t) throw new Error(`stand-in: no transfer ${reference}`);
    const from = this.accounts.get(t.fromAccountId)!;
    const to = this.accounts.get(t.toAccountId)!;
    const was = t.status;
    if (status === 'successful' && UNFINISHED.has(was)) {
      to.availableKobo += t.amountKobo;
    } else if (
      (status === 'failed' || status === 'cancelled') &&
      UNFINISHED.has(was)
    ) {
      from.availableKobo += t.amountKobo + t.feeKobo;
    } else if (status === 'reversed' && was === 'successful') {
      to.availableKobo -= t.amountKobo;
      from.availableKobo += t.amountKobo + t.feeKobo;
    }
    // Any other word Nuvion might send moves no money here.
    t.status = status;
    t.statusReason =
      status === 'failed' ? 'compliance_hold' : `now ${String(status)}`;
  }

  sendsFrom(accountId: string): NuvionTransfer[] {
    return this.transfers.filter((t) => t.fromAccountId === accountId);
  }

  private error(
    type: string,
    operation: string,
    reference: string | null = null,
    httpStatus: number | null = null,
  ): WalletProviderError {
    const e = NUVION_ERROR_KINDS[type];
    if (!e) throw new Error(`stand-in: no mapping for ${type}`);
    return new WalletProviderError({
      kind: e.kind,
      provider: 'nuvion',
      operation,
      httpStatus,
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

  /** The account a reference names: its NGN account number, its id or its `nuvion_ban`. */
  private resolve(ref: string): NuvionAccount | null {
    for (const a of this.accounts.values()) {
      if (
        a.accountNumber === ref ||
        a.accountId === ref ||
        a.nuvionBan === ref
      ) {
        return a;
      }
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
      // The docs' transfer object carries `applicable_fee`.
      feeKobo: t.feeKobo,
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

  isSameAccount(a: string, b: string): Promise<boolean> {
    this.calls.push({ method: 'isSameAccount', args: { a, b } });
    if (a === b) return Promise.resolve(true);
    const x = this.resolve(a);
    const y = this.resolve(b);
    return Promise.resolve(!!x && !!y && x.accountId === y.accountId);
  }

  async walletToWallet(
    input: ProviderWalletTransferInput,
  ): Promise<ProviderTransferReceipt> {
    this.calls.push({ method: 'walletToWallet', args: input });
    // The network round trip the real adapter makes.
    await Promise.resolve();
    const op = 'book transfer';
    if (this.mode === 'not_supported') throw this.notSupported(op);
    const from = this.resolve(input.fromAccountNumber);
    const to = this.resolve(input.toAccountNumber);
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
    // The same unique_reference for the account: 409 with the original
    // transfer (whose id the adapter keeps), or a mismatch when the
    // parameters differ. Never a second transfer.
    const original = this.transfers.find(
      (t) =>
        t.fromAccountId === from.accountId &&
        t.request.unique_reference === input.reference,
    );
    if (original) {
      if (original.request.amount !== request.amount) {
        throw this.error(
          'error_idempotency_key_mismatch',
          op,
          input.reference,
          409,
        );
      }
      this.keptIds.set(input.reference, original.id);
      throw this.error('duplicate_original', op, input.reference, 409);
    }

    const mode = this.mode;
    const refusals: Partial<Record<NuvionSendMode, [string, number]>> = {
      account_not_active: ['error_transfer_account_not_active', 400],
      compliance_rejected: ['error_transfer_compliance_rejected', 422],
      already_processing: ['error_transfer_already_processing', 409],
      request_processing: ['error_idempotency_request_processing', 409],
      auth: ['error_auth_credentials_invalid', 401],
      rate_limited: ['error_auth_rate_limit_exceeded', 429],
      insufficient: [
        'error_transfer_insufficient_funds',
        this.insufficientStatus,
      ],
    };
    const refusal = refusals[mode];
    if (refusal) throw this.error(refusal[0], op, input.reference, refusal[1]);
    if (mode === 'limit') {
      throw providerLimitError('nuvion', this.limitError, {
        operation: op,
        httpStatus: 400,
        messages: [this.limitError],
        reference: input.reference,
      })!;
    }
    if (mode === 'timeout_nothing') {
      throw this.error('lost_answer', op, input.reference);
    }
    if (mode === 'system_error' && !this.systemError.created) {
      throw this.error(
        this.systemError.type,
        op,
        input.reference,
        this.systemError.httpStatus,
      );
    }
    const amountKobo = input.amountKobo + this.extraKobo;
    const feeKobo = this.feeKobo(input.amountKobo);
    if (from.availableKobo < amountKobo + feeKobo) {
      throw this.error(
        'error_transfer_insufficient_funds',
        op,
        input.reference,
        this.insufficientStatus,
      );
    }
    const status: NuvionTransferStatus =
      mode === 'successful'
        ? 'successful'
        : mode === 'processing'
          ? 'processing'
          : 'pending';
    const t: NuvionTransfer = {
      id: ulid(),
      request,
      fromAccountId: from.accountId,
      toAccountId: to.accountId,
      amountKobo,
      feeKobo,
      status,
      statusReason:
        status === 'successful' ? 'completed' : 'awaiting_processing',
      created: Date.now(),
    };
    this.transfers.push(t);
    // Accepted: the amount and fee leave `available` now; the receiver is
    // credited when the transfer succeeds.
    from.availableKobo -= amountKobo + feeKobo;
    if (status === 'successful') to.availableKobo += amountKobo;
    if (mode === 'timeout') {
      // Nuvion took it; the answer never reached us, so no id is kept.
      throw this.error('lost_answer', op, input.reference);
    }
    if (mode === 'system_error') {
      throw this.error(
        this.systemError.type,
        op,
        input.reference,
        this.systemError.httpStatus,
      );
    }
    this.keptIds.set(input.reference, t.id);
    return this.answerFor(t, op);
  }

  /** The seam's answer for a transfer Nuvion holds: a receipt only once it is `successful`. */
  private answerFor(t: NuvionTransfer, op: string): ProviderTransferReceipt {
    if (UNFINISHED.has(t.status)) {
      throw this.error('accepted_unfinished', op, t.request.unique_reference);
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

  /**
   * What Nuvion knows of one of our sends: by the id the adapter kept
   * (`GET /transfers/{id}`), else a walk of the payer's transfers for our
   * `unique_reference` (`GET /transfers?entity_id=&account_id=`).
   */
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
    const kept = this.keptIds.get(reference);
    if (kept) {
      const t = this.transfers.find((x) => x.id === kept);
      if (t) {
        return Promise.resolve({
          state: 'found',
          source: 'lookup',
          transaction: this.transaction(t),
        });
      }
    }
    const entity = holder.kind === 'customer' ? holder.customerId : null;
    const t = this.transfers.find(
      (x) =>
        x.request.unique_reference === reference &&
        (entity === null || x.request.entity_id === entity),
    );
    if (!t) return Promise.resolve({ state: 'absent' });
    return Promise.resolve({
      state: 'found',
      source: 'history',
      transaction: this.transaction(t),
    });
  }

  /** Nuvion has no lookup by our reference (only by its own id). */
  findTransactionByReference(): Promise<ProviderLookup> {
    return Promise.reject(this.notSupported('lookup by our reference'));
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
    if (
      r.state === 'found' &&
      r.transaction.outcome !== null &&
      r.transaction.outcome !== 'pending'
    ) {
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
