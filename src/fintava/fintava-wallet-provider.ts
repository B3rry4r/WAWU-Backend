import { Injectable } from '@nestjs/common';
import {
  type OtpResetCode,
  type OtpSender,
  type ProviderAccountName,
  type ProviderAccountNameInput,
  type ProviderBalance,
  type ProviderBank,
  type ProviderBankTransferInput,
  type ProviderBvnDigest,
  type ProviderConfirmLimits,
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
  type ProviderOpenWalletInput,
  type ProviderPage,
  type ProviderPageQuery,
  type ProviderPlatformAccount,
  type ProviderReconciliation,
  type ProviderRetryDecision,
  type ProviderSelfieInput,
  type ProviderSelfieResult,
  type ProviderSendKind,
  type ProviderTransaction,
  type ProviderTransferReceipt,
  type ProviderWalletTransferInput,
  safeKoboNumber,
  type WalletProvider,
  type WalletProviderCapabilities,
  type WalletProviderTimings,
} from '../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../wallet-provider/wallet-provider-error';
import { FintavaClient } from './fintava-client';
import { FINTAVA_DEFAULTS, FINTAVA_WALLET_BANK_CODE } from './fintava-config';
import { FintavaError } from './fintava-error';
import {
  LEDGER_WEBHOOK_EVENTS,
  ledgerStatusOf,
  readLedgerWebhook,
} from './fintava-ledger-delivery';
import { decideFintavaRetry } from './fintava-reconcile';
import type {
  FintavaCustomer,
  FintavaCustomerMatch,
  FintavaLookup,
  FintavaPage,
  FintavaTransaction,
  FintavaTransferReceipt,
} from './fintava.interface';

const MINUTE = 60_000;

/** A Fintava failure in the seam's neutral words; anything else passes through. */
export function toWalletProviderError(e: unknown): unknown {
  if (!(e instanceof FintavaError)) return e;
  return new WalletProviderError({
    kind: e.kind,
    provider: 'fintava',
    operation: e.operation,
    httpStatus: e.httpStatus,
    messages: e.messages,
    reference: e.reference,
    recordMayExist: e.recordMayExist,
    retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
  });
}

/** Runs a client call and turns a FintavaError into a WalletProviderError. */
async function translated<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw toWalletProviderError(e);
  }
}

function notSupported(operation: string): WalletProviderError {
  return new WalletProviderError({
    kind: 'not_supported',
    provider: 'fintava',
    operation,
    retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
  });
}

/** Fintava's transaction as the seam's. Fintava's three references keep their meaning. */
export function fromFintavaTransaction(
  t: FintavaTransaction,
): ProviderTransaction {
  return {
    id: t.id,
    createdAt: t.createdAt,
    amountKobo: BigInt(t.amountKobo),
    status: t.status,
    outcome: ledgerStatusOf(t.status),
    ourReference: t.customerReference,
    providerReference: t.fintavaReference,
    secondaryReference: t.tagapayTransRef,
    sessionId: t.sessionId,
  };
}

function fromFintavaCustomer(c: FintavaCustomer): ProviderCustomer {
  return {
    customerId: c.customerId,
    walletId: c.walletId,
    accountNumber: c.accountNumber,
    accountName: c.accountName,
  };
}

function fromFintavaMatch(m: FintavaCustomerMatch): ProviderCustomerMatch {
  return { customer: fromFintavaCustomer(m.customer), bvnDigest: m.bvnDigest };
}

function fromFintavaLookup(l: FintavaLookup): ProviderLookup {
  return l.state === 'found'
    ? { state: 'found', transaction: fromFintavaTransaction(l.transaction) }
    : l;
}

function fromFintavaPage<T, U>(
  page: FintavaPage<T>,
  map: (t: T) => U,
): ProviderPage<U> {
  return { items: page.items.map(map), hasNextPage: page.hasNextPage };
}

function fromFintavaReceipt(
  r: FintavaTransferReceipt,
): ProviderTransferReceipt {
  return {
    ourReference: r.customerReference,
    providerReference: r.fintavaReference,
    secondaryReference: r.tagapayTransRef,
    transactionId: r.transactionId,
    amountKobo: BigInt(r.amountKobo),
    totalKobo: BigInt(r.totalKobo),
    feeKobo: BigInt(r.feeKobo),
    sourceAvailableKobo:
      r.sourceAvailableKobo === null ? null : BigInt(r.sourceAvailableKobo),
  };
}

/**
 * The Fintava adapter behind the wallet provider seam (task MONEY-20).
 *
 * It wraps the MONEY-06 client and changes nothing it does: every method is
 * the same client call, with the same arguments, in the same order, as the
 * money service that used to make it directly. What it adds is the
 * translation: Fintava's results into the seam's neutral types (kobo as
 * bigint, references by meaning), and `FintavaError` into
 * `WalletProviderError` with the same kind, so every decision a service
 * makes on a failure is unchanged.
 *
 * Fintava's own quirks stay here, not in `src/money/`: the delivery
 * payloads (fintava-ledger-delivery.ts), the reconcile and retry rules
 * (fintava-reconcile.ts and the client), and the history walk that confirms
 * a delivery (`confirmMovement`, moved from the ledger consumer unchanged).
 *
 * What Fintava has no equivalent for answers `not_supported`: a hosted
 * liveness session and a separate KYC submission (Fintava checks the BVN
 * and matches a selfie itself, and opens the account in one call).
 */
@Injectable()
export class FintavaWalletProvider implements WalletProvider {
  readonly name = 'fintava' as const;
  readonly label = 'Fintava';
  readonly walletBankCode = FINTAVA_WALLET_BANK_CODE;
  readonly capabilities: WalletProviderCapabilities = {
    selfieMatch: true,
    hostedLiveness: false,
    separateKyc: false,
    asyncAccountNumber: false,
    identityLookup: true,
  };
  readonly deliveries: ProviderDeliveries = {
    ledgerEvents: LEDGER_WEBHOOK_EVENTS,
    read: (event, payload, eventReference) =>
      readLedgerWebhook(event, payload, eventReference),
  };

  constructor(private readonly client: FintavaClient) {}

  get configured(): boolean {
    return this.client.environment !== 'unconfigured';
  }

  /** Read from the client's settings each time, never copied at boot. */
  get timings(): WalletProviderTimings {
    const s = this.client.settings;
    return {
      readTimeoutMs: s.readTimeoutMs,
      moneyTimeoutMs: s.moneyTimeoutMs,
      checkTimeoutMs: s.checkTimeoutMs,
      resendSafetyMs: s.resendSafetyMs,
      retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
    };
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  checkIdentity(bvn: string): Promise<ProviderIdentity> {
    return translated(async () => {
      const i = await this.client.verifyBvn(bvn);
      return {
        firstName: i.firstName,
        middleName: i.middleName,
        lastName: i.lastName,
        dateOfBirth: i.dateOfBirth,
        phone: i.phone,
        gender: i.gender,
        imageBase64: i.imageBase64,
      };
    });
  }

  matchSelfie(input: ProviderSelfieInput): Promise<ProviderSelfieResult> {
    return translated(async () => {
      const r = await this.client.verifyBvnSelfie({
        bvn: input.bvn,
        imageBase64: input.imageBase64,
      });
      return { matched: r.matched, confidence: r.confidence };
    });
  }

  startLivenessSession(): Promise<ProviderLivenessSession> {
    return Promise.reject(notSupported('start liveness session'));
  }

  getLivenessResult(): Promise<ProviderLivenessResult> {
    return Promise.reject(notSupported('read liveness result'));
  }

  submitKyc(): Promise<ProviderKycState> {
    return Promise.reject(notSupported('submit KYC'));
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  openWallet(input: ProviderOpenWalletInput): Promise<ProviderOpenedWallet> {
    return translated(async () => {
      const customer = await this.client.createCustomer({
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email: input.email,
        address: input.address,
        dateOfBirth: input.dateOfBirth,
        bvn: input.bvn,
        nin: input.nin,
      });
      return { state: 'open', customer: fromFintavaCustomer(customer) };
    });
  }

  /** Fintava answers the account with the customer: never pending. */
  getWalletAccount(customerId: string): Promise<ProviderCustomer | null> {
    return translated(async () =>
      fromFintavaCustomer(await this.client.getCustomer(customerId)),
    );
  }

  findCustomerByPhone(
    phone: string,
    digest: ProviderBvnDigest,
  ): Promise<ProviderCustomerLookup> {
    return translated(async () => {
      const l = await this.client.lookupCustomerByPhone(phone, digest);
      return l.state === 'found'
        ? { state: 'found', ...fromFintavaMatch(l) }
        : l;
    });
  }

  getCustomerMatch(
    customerId: string,
    digest: ProviderBvnDigest,
  ): Promise<ProviderCustomerMatch> {
    return translated(async () =>
      fromFintavaMatch(await this.client.getCustomerMatch(customerId, digest)),
    );
  }

  listCustomerSightings(
    query: Omit<ProviderPageQuery, 'order'>,
  ): Promise<ProviderPage<ProviderCustomerSighting>> {
    return translated(async () =>
      fromFintavaPage(
        await this.client.listCustomerSightings({
          page: query.page,
          take: query.take,
        }),
        (r) => ({
          customerId: r.customerId,
          phone: r.phone,
          createdAt: r.createdAt,
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Balances
  // -------------------------------------------------------------------------

  getBalance(wallet: { walletId: string }): Promise<ProviderBalance> {
    return translated(async () => {
      const b = await this.client.getWalletBalance(wallet.walletId);
      return {
        availableKobo: BigInt(b.availableKobo),
        bookedKobo: BigInt(b.bookedKobo),
      };
    });
  }

  getPlatformAccount(): Promise<ProviderPlatformAccount> {
    return translated(async () => {
      const m = await this.client.getMerchantBalance();
      return {
        accountNumber: m.accountNumber,
        accountName: m.accountName,
        availableKobo: BigInt(m.availableKobo),
        bookedKobo: BigInt(m.bookedKobo),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Banks
  // -------------------------------------------------------------------------

  listBanks(): Promise<ProviderBank[]> {
    return translated(async () =>
      (await this.client.listBanks()).map((b) => ({
        code: b.code,
        name: b.name,
      })),
    );
  }

  checkAccountName(
    input: ProviderAccountNameInput,
  ): Promise<ProviderAccountName> {
    return translated(async () => {
      const a = await this.client.bankNameEnquiry(
        input.accountNumber,
        input.bankCode,
      );
      return {
        matched: a.matched,
        accountName: a.accountName,
        accountNumber: a.accountNumber,
        bankCode: a.bankCode,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Moving money (no caller on main yet: MONEY-17, WALLET-07, WALLET-09)
  // -------------------------------------------------------------------------

  bankTransfer(
    input: ProviderBankTransferInput,
  ): Promise<ProviderTransferReceipt> {
    return translated(async () => {
      const amountKobo = safeKoboNumber(input.amountKobo);
      if (input.from.kind === 'merchant') {
        if (!input.accountName) {
          throw new WalletProviderError({
            kind: 'validation',
            provider: 'fintava',
            operation: 'merchant bank transfer',
            messages: ["the receiving account's name is required"],
            reference: input.reference,
            recordMayExist: false,
          });
        }
        return fromFintavaReceipt(
          await this.client.merchantBankTransfer({
            accountNumber: input.accountNumber,
            accountName: input.accountName,
            sortCode: input.bankCode,
            amountKobo,
            customerReference: input.reference,
            narration: input.narration,
          }),
        );
      }
      return fromFintavaReceipt(
        await this.client.bankTransfer({
          sourceCustomerId: input.from.customerId,
          accountNumber: input.accountNumber,
          accountName: input.accountName,
          sortCode: input.bankCode,
          amountKobo,
          customerReference: input.reference,
          narration: input.narration,
        }),
      );
    });
  }

  walletToWallet(
    input: ProviderWalletTransferInput,
  ): Promise<ProviderTransferReceipt> {
    return translated(async () =>
      fromFintavaReceipt(
        await this.client.walletToWallet({
          senderAccountNumber: input.fromAccountNumber,
          receiverAccountNumber: input.toAccountNumber,
          amountKobo: safeKoboNumber(input.amountKobo),
          customerReference: input.reference,
          narration: input.narration,
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  findTransactionByReference(reference: string): Promise<ProviderLookup> {
    return translated(async () =>
      fromFintavaLookup(await this.client.getTransactionByReference(reference)),
    );
  }

  findTransactionById(id: string): Promise<ProviderLookup> {
    return translated(async () =>
      fromFintavaLookup(await this.client.getTransactionById(id)),
    );
  }

  listTransactions(
    holder: ProviderHolder,
    query: ProviderPageQuery,
  ): Promise<ProviderPage<ProviderTransaction>> {
    return translated(async () =>
      fromFintavaPage(
        holder.kind === 'merchant'
          ? await this.client.getMerchantHistory({
              page: query.page,
              take: query.take,
              order: query.order,
            })
          : await this.client.getCustomerHistory({
              customerId: holder.customerId,
              page: query.page,
              take: query.take,
            }),
        fromFintavaTransaction,
      ),
    );
  }

  reconcileSend(
    reference: string,
    holder: ProviderHolder,
    since?: Date,
  ): Promise<ProviderReconciliation> {
    return translated(async () => {
      const r = await this.client.reconcile(reference, holder, since);
      return r.state === 'found'
        ? {
            state: 'found',
            source: r.source,
            transaction: fromFintavaTransaction(r.transaction),
          }
        : r;
    });
  }

  decideRetry(
    kind: ProviderSendKind,
    reconciliation: ProviderReconciliation,
    clock: { attemptedAt: Date; now: Date; resendAfterMs: number },
  ): ProviderRetryDecision {
    return decideFintavaRetry<ProviderTransaction>(kind, reconciliation, clock);
  }

  /** The by-id record's tagapayTransRef: the only Fintava record that carries it. */
  async secondaryReferenceOf(t: ProviderTransaction): Promise<string | null> {
    if (t.secondaryReference) return t.secondaryReference;
    try {
      const l = await this.client.getTransactionById(t.id);
      return l.state === 'found' ? l.transaction.tagapayTransRef : null;
    } catch (e) {
      if (e instanceof FintavaError) return null;
      throw e;
    }
  }

  /**
   * What Fintava knows about a movement named by these references (moved
   * unchanged from LedgerConsumerService.confirm, MONEY-10): the lookup by
   * each (ours and Fintava's are findable), then, for a sender of ours, its
   * history (debits only), matching any reference, and rows of the same
   * amount read by id for their tagapayTransRef.
   */
  async confirmMovement(input: {
    references: readonly string[];
    sender: ProviderHolder | null;
    amountKobo: number;
    around: Date;
    limits: ProviderConfirmLimits;
  }): Promise<ProviderMovementConfirmation> {
    const { sender, amountKobo, around, limits } = input;
    const found = (
      transaction: FintavaTransaction,
      tagapayTransRef: string | null,
    ): ProviderMovementConfirmation => ({
      state: 'found',
      transaction: fromFintavaTransaction(transaction),
      secondaryReference: tagapayTransRef,
    });
    if (!this.configured) {
      // Nothing is sent; one answer, not a warning per reference.
      return { state: 'unknown', why: 'not_configured' };
    }
    const refs = [...new Set(input.references)].filter(
      (r) => !r.startsWith('sha256:'),
    );
    let unclear = '';
    for (const ref of refs.slice(0, 4)) {
      try {
        const l = await this.client.getTransactionByReference(ref);
        if (l.state === 'found') {
          return found(l.transaction, await this.tagapayOf(l.transaction));
        }
        if (l.state === 'unknown') unclear = 'empty_lookup';
      } catch (e) {
        if (!(e instanceof FintavaError)) throw e;
        unclear =
          e.kind === 'not_configured' ? 'not_configured' : 'unreachable';
        if (e.kind === 'not_configured' || e.kind === 'auth') {
          return { state: 'unknown', why: unclear };
        }
      }
    }
    if (sender) {
      const has = (t: FintavaTransaction) =>
        [t.customerReference, t.fintavaReference, t.tagapayTransRef].some(
          (v) => v !== null && refs.includes(v),
        );
      const sameAmount: FintavaTransaction[] = [];
      try {
        for (let page = 1; page <= limits.historyPages; page += 1) {
          const rows =
            sender.kind === 'merchant'
              ? await this.client.getMerchantHistory({
                  page,
                  take: 100,
                  order: 'DESC',
                })
              : await this.client.getCustomerHistory({
                  customerId: sender.customerId,
                  page,
                  take: 100,
                });
          const hit = rows.items.find(has);
          if (hit) return found(hit, await this.tagapayOf(hit));
          for (const t of rows.items) {
            const when = Date.parse(t.createdAt);
            if (
              t.amountKobo === amountKobo &&
              t.tagapayTransRef === null &&
              Math.abs(when - around.getTime()) < 24 * 60 * MINUTE
            ) {
              sameAmount.push(t);
            }
          }
          if (!rows.hasNextPage || rows.items.length === 0) break;
        }
        // Nearest in time first: history is not sorted the same way for
        // customers and for WAWU (`sandbox/09-`, `10-`).
        sameAmount.sort(
          (x, y) =>
            Math.abs(Date.parse(x.createdAt) - around.getTime()) -
            Math.abs(Date.parse(y.createdAt) - around.getTime()),
        );
        for (const t of sameAmount.slice(0, limits.byIdChecks)) {
          const l = await this.client.getTransactionById(t.id);
          if (l.state === 'found' && has(l.transaction)) {
            return found(l.transaction, l.transaction.tagapayTransRef);
          }
          if (l.state === 'unknown') unclear = unclear || 'empty_lookup';
        }
      } catch (e) {
        if (!(e instanceof FintavaError)) throw e;
        unclear = 'unreachable';
      }
    }
    return unclear ? { state: 'unknown', why: unclear } : { state: 'absent' };
  }

  /** The by-id record's tagapayTransRef, as the consumer read it. */
  private async tagapayOf(t: FintavaTransaction): Promise<string | null> {
    if (t.tagapayTransRef) return t.tagapayTransRef;
    try {
      const l = await this.client.getTransactionById(t.id);
      return l.state === 'found' ? l.transaction.tagapayTransRef : null;
    } catch (e) {
      if (e instanceof FintavaError) return null;
      throw e;
    }
  }
}

/**
 * Fintava's SMS as the PIN reset's code sender (MONEY-14 through the seam).
 * Same call, same masking; a failure is a WalletProviderError of the same
 * kind, so "may have arrived" and "not sent" are told apart as before.
 */
@Injectable()
export class FintavaOtpSender implements OtpSender {
  /** Fintava texts the code to the proved phone. */
  readonly channel = 'sms' as const;

  constructor(private readonly client: FintavaClient) {}

  get configured(): boolean {
    return this.client.environment !== 'unconfigured';
  }

  sendText(phone: string, text: string): Promise<void> {
    return translated(() => this.client.sendSms(phone, text));
  }

  /** The same text to the same phone as before NUV-01: one SMS. */
  sendResetCode(code: OtpResetCode): Promise<void> {
    return this.sendText(code.phone ?? '', code.text);
  }
}
