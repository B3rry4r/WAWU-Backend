import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  BANK_SEND_REFERENCE_PREFIX,
  type ProviderReconciliation,
  type ProviderTransaction,
  type ProviderTransferReceipt,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import { WalletBalanceService } from '../balance/wallet-balance.service';
import { FeeQuoteService } from '../fees/fee-quote.service';
import type { OpenWallet } from '../gate/wallet-gate';
import {
  insufficientAfterProviderRefusal,
  insufficientFunds,
} from '../insufficient-funds';
import type { LedgerMovementInput } from '../ledger/ledger.interface';
import {
  koboNumber,
  LEDGER_FINTAVA_FAILURE,
  LedgerService,
} from '../ledger/ledger.service';
import { MoneyLimits } from '../limits/money-limits.service';
import type { MoneyLimitKind } from '../limits/money-limit-config';
import { MoneyError } from '../money-error';
import { loadMoneyParties } from '../money-party';
import type {
  BankAccountView,
  MoneyPartyView,
  TransferReversalView,
  TransferStatus,
  TransferTimelineEntry,
  TransferView,
} from '../money-view.type';
import type {
  BankTransferDto,
  WawuTransferDto,
} from '../dto/money-request.dto';
import {
  type IdempotencyScope,
  IdempotencyService,
} from '../payments/idempotency';
import { PaymentSettings } from '../payments/payment-config';
import { completedFigures, joinNotes } from '../payments/payment-figures';
import {
  nextCheckDelayMs,
  successBody,
} from '../payments/wallet-payment.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import { SavedAccountTargetService } from '../saved-accounts/saved-account-target.service';
import type { ResolvedBankTarget } from './bank-send-target';
import {
  TransferRecipients,
  type TransferRecipient,
} from './transfer-recipient';
import { splitCharge } from './transfer-figures';

/** The route a send's Idempotency-Key is scoped to. */
export const TRANSFER_ROUTE = 'POST money/transfers/wawu';
/** The same for a send to a bank account (WALLET-09). */
export const BANK_TRANSFER_ROUTE = 'POST money/transfers/bank';

/** What the provider sees on the transfer. Names nobody and nothing personal. */
export const TRANSFER_NARRATION = 'WAWU transfer';

/** Someone else's send is the same 404 as one nobody holds (CONVENTIONS.md section 3). */
export const TRANSFER_NOT_FOUND_MESSAGE = 'We could not find that send.';
/** Only when the provider refused the transfer or said it failed: its word, not our inference. */
export const TRANSFER_FAILED_REASON =
  'The send did not go through. No money left your wallet.';
/** A send the provider reversed. Never says what came back: only the provider's own record knows. */
export const TRANSFER_REVERSED_REASON =
  'This send was reversed. Check your balance for what came back.';
/**
 * Beside every `pending` send (the same rule as a payment's, lead ruling D1):
 * the outcome is not known yet, so nothing says no money moved, and the
 * sender is told not to send again.
 */
export const SEND_STILL_CONFIRMING_MESSAGE =
  "We're still confirming this send. Don't send it again; we'll let you know.";

/** Rows per page of the sweep, and pages per pass. */
const SWEEP_PAGE = 50;
const SWEEP_PAGES = 20;
const MINUTE = 60_000;
/** How long the receipt waits for WAWU ID before it names the person from our own records. */
const PARTY_WAIT_MS = 3_000;

type TransferRow = Prisma.WalletTransferGetPayload<object>;

/**
 * Provider refusals that mean no money moved and the person can fix it, or
 * the provider cannot take sends here at all: the key is given back and the
 * refusal is answered as it is. `not_supported` is a provider whose adapter
 * has no book transfer yet (Nuvion before NUV-05): nothing was sent, so it is
 * answered like a provider that is not set up (503), never stored as a failed
 * send for the person to see as their own failure.
 */
const RELEASED: readonly WalletProviderErrorKind[] = [
  'insufficient_funds',
  'wallet_inactive',
  'not_configured',
  'auth',
  'merchant_inactive',
  'rate_limited',
  'unavailable',
  'not_supported',
  'below_minimum',
  // The provider will not pay out right now (a bank send): nothing was sent.
  'payouts_blocked',
];

/**
 * Refusals after which a send is failed at once, although the provider may
 * have written a record under our reference (WALLET-09 round 2, verifier
 * finding 2): the provider said no before it took the money, so no transfer
 * exists to settle. Read from the sandbox, not guessed:
 * - `insufficient_funds` and `wallet_inactive` (a frozen sender): "nothing
 *   moved" and the reference was not used up (mobile repo
 *   docs/fintava/sandbox/13- and 15-, wallet to wallet; the bank send checks
 *   the same balance and the same wallet first);
 * - `payouts_blocked` ("Unable to find customers"): the refused bank send
 *   left only an orphan PENDING record that never moved a balance and was
 *   still pending 37 minutes on (sandbox/14-, which tells the client to
 *   treat such a row as no money moved and to retry under a new reference).
 * The reference is burned either way; a retry is a new send under a new one.
 * Any other refusal of a bank send keeps `recordMayExist` and waits for the
 * reconcile: nothing recorded says it created no transfer (BACKEND_GAPS
 * G-767 lists the kinds the sandbox still has to answer).
 */
const NO_TRANSFER_REFUSALS: readonly WalletProviderErrorKind[] = [
  'insufficient_funds',
  'wallet_inactive',
  'payouts_blocked',
];

/** The rest before the next check of a pending send: 1, 2, 4 ... minutes, at most an hour. */
export const nextSendCheckDelayMs = nextCheckDelayMs;

/**
 * Send money to a WAWU user (task WALLET-07; W7 to W12): one wallet-to-wallet
 * transfer at the wallet provider from the sender's wallet to the receiver's.
 *
 * - **Through the provider seam** (MONEY-20): every call goes through
 *   `WALLET_PROVIDER` (Fintava, or Nuvion's book transfer once NUV-05 serves
 *   it); each send records which provider took it (`provider`), and the sweep
 *   asks only the provider this server runs about its own sends. Under a
 *   provider whose adapter has no book transfer yet the send answers `503`
 *   before any money moves (`not_supported`, nothing claimed that stays).
 * - **The money.** The sender's balance falls by the quoted total: the
 *   amount, the provider's charge and WAWU's fee on top (R-10, the fee quote
 *   WALLET-15 gave, signed and checked here); the receiver's rises by exactly
 *   the amount. The provider collects WAWU's fee in the same transfer (its
 *   dashboard charge), so there is no second transfer. What the provider's
 *   own record says it took is the record (`completedFigures`), as for a
 *   payment: a difference is kept on `discrepancy`, a believable excess is
 *   flagged, a charge nobody can believe stops the send for review.
 * - **Once per key.** The Idempotency-Key is taken before the PIN; the send,
 *   its pending ledger row and the key's link to it are written in one
 *   transaction before the provider is called (idempotency.ts). A retry, two
 *   taps at once on one Hub or on two, and a Hub that dies between the
 *   provider's answer and our write all end in one transfer: the send exists
 *   before the provider hears of it, the provider is asked about it by OUR
 *   reference, and nothing here sends a second time.
 * - **An unknown outcome is `pending` until the provider says** (lead ruling
 *   D1, MONEY-17): a timeout, a 5xx, a 2xx without a transaction, a repeated
 *   reference, a transfer the provider accepted and has not completed yet.
 *   Absence is never proof that no money moved. The one exception is a
 *   request that PROVABLY never left (a refused connection, a host name that
 *   did not resolve: `requestNotSent`, decided by error code and syscall,
 *   MONEY-18): nothing reached the provider, so the send is failed, the key
 *   is given back and the same key sends it again as a new send.
 * - **Before money moves**, in order: the wallet (gate), the key, who the
 *   money goes to (`TransferRecipientGuard`: yourself, a closed account, a
 *   block, no wallet), the PIN (guards), the body, the quote (`409
 *   quote_changed`), the provider's available balance (`402 insufficient_
 *   funds` with a real shortfall, never a sum of our own records), WAWU's
 *   limits (`limit_reached`).
 * - **Ledger.** The sender's `out` row is written pending with the claim; the
 *   receiver's `in` row only once the send is confirmed, so a person never
 *   sees money coming in that has not arrived. Every way a send completes
 *   goes through `completeFromRecord`.
 * - **Polled by its id** (`read`): `GET /money/transfers/{id}` reads our
 *   record only and never asks the provider.
 */
@Injectable()
export class WalletTransferService implements OnModuleInit {
  private readonly logger = new Logger(WalletTransferService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly balances: WalletBalanceService,
    private readonly recipients: TransferRecipients,
    private readonly keys: IdempotencyService,
    private readonly settings: PaymentSettings,
    private readonly limits: MoneyLimits,
    private readonly wawuId: WawuIdClient,
    /** Keeps a bank send's payee ids on the saved place it went to (WALLET-09). */
    private readonly saved: SavedAccountTargetService,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` by a request that died (a restart mid-send)
    // is answered from its send once the request can no longer be running.
    for (const route of [TRANSFER_ROUTE, BANK_TRANSFER_ROUTE]) {
      this.keys.onStale(
        route,
        this.provider.timings.moneyTimeoutMs + MINUTE,
        async (row) => {
          const t = row.resourceId
            ? await this.prisma.walletTransfer.findUnique({
                where: { id: row.resourceId },
              })
            : null;
          return t
            ? { status: 201, body: successBody(await this.view(t)) }
            : null;
        },
      );
    }
    // A send's ledger row settled by anything settles the send now.
    this.ledger.onTransferSettled((e) => this.settle(e.transferId));
  }

  // -------------------------------------------------------------------------
  // Sending (W10 to W12)
  // -------------------------------------------------------------------------

  async send(
    wallet: OpenWallet,
    dto: WawuTransferDto,
    scope: IdempotencyScope,
  ): Promise<TransferView> {
    const payer = wallet.wawuUserId;
    // Who the money goes to, read again now: the guard asked before the PIN,
    // and a block or a deletion since is caught here, before anything is claimed.
    const recipient = await this.recipients.resolve(
      payer,
      dto.recipientWawuUserId,
    );
    const note = dto.note?.trim() ? dto.note.trim() : null;
    const fee = this.fees.check(
      payer,
      { kind: 'wawu_transfer', amountKobo: dto.amountKobo },
      dto.expectedTotalKobo,
      dto.quoteToken,
      new Date(),
    );

    // The provider's balance, never ours: a 503 or a 423 here moves nothing.
    const { availableKobo } = await this.balances.balance(wallet);
    if (availableKobo < fee.totalKobo) {
      throw insufficientFunds(availableKobo, fee.totalKobo);
    }

    const names = await this.namesOf(payer, recipient);
    const id = randomUUID();
    const now = new Date();
    const data: Prisma.WalletTransferCreateInput = {
      id,
      kind: 'wawu_user',
      payerWawuUserId: payer,
      recipientWawuUserId: recipient.wawuUserId,
      payerName: names.payer,
      recipientName: names.recipient,
      amountKobo: BigInt(dto.amountKobo),
      providerFeeKobo: BigInt(fee.fee.providerFeeKobo),
      wawuFeeKobo: BigInt(fee.fee.wawuFeeKobo),
      totalKobo: BigInt(fee.totalKobo),
      note,
      customerReference: `wawu-send-${id}`,
      payerAccountNumber: wallet.accountNumber,
      recipientAccountNumber: recipient.accountNumber,
      provider: this.provider.name,
      status: 'pending',
      nextCheckAt: new Date(now.getTime() + MINUTE),
      sentAt: now,
    };

    // The CLAIM: the send, its pending ledger row and the key's link to it,
    // in one transaction, before the provider is called (a crash after the
    // send still leaves a send the sweep settles, and a repeat of the key is
    // answered from this send).
    const transfer = await this.claim(scope, data);

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: wallet.accountNumber,
        toAccountNumber: recipient.accountNumber,
        amountKobo: BigInt(dto.amountKobo),
        reference: transfer.customerReference,
        narration: TRANSFER_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(transfer, scope, e, wallet);
    }
    return this.afterReceipt(transfer, scope, receipt);
  }

  /**
   * Send money to a bank account (task WALLET-09; W8 to W14, and a
   * withdrawal, W17 to W19, which is a bank send to the payout account). The
   * same send as the one to a WAWU user, in the same order and with the same
   * guarantees (see the class comment), with these differences:
   *
   * - **The target is decided before the PIN** (`BankSendTargetGuard`, the
   *   name check and the saved-account gate, NUV-06's notes N3 and N5) and
   *   arrives here resolved: the bank's code in the provider's list, its
   *   name, the account number and the holder's name the bank gave just now.
   * - **The quote is the bank's** (`bank_transfer`: the provider's charge for
   *   a bank send plus WAWU's fee, R-10), checked here (`409 quote_changed`).
   * - **The row is written first** (N6): the send, with `providerFeeKobo` and
   *   `wawuFeeKobo` as quoted, and its pending ledger row, in the claim (the
   *   limits are checked in the same transaction, WALLET-23), BEFORE the
   *   provider hears of the send, so a delivery that lands first finds the
   *   row at the quote's figures.
   * - **Called once** (N2). A request that provably never left is failed and
   *   the key given back; an unknown outcome (`outcome_unknown`,
   *   `not_confirmed`, `duplicate_reference`) is `pending` and found again by
   *   our reference (`reconcileSend` through the seam, the sweep). Nothing
   *   here calls `bankTransfer` a second time, and the error flags are read
   *   only for the call that failed.
   * - **Money in at the other bank** has no `in` row: only the sender's side
   *   is ours. The bank's answer arrives later (a delivery, or the sweep) and
   *   the app reads it from `GET /money/transfers/{id}`.
   */
  async sendToBank(
    wallet: OpenWallet,
    dto: BankTransferDto,
    scope: IdempotencyScope,
    resolved: ResolvedBankTarget,
  ): Promise<TransferView> {
    const payer = wallet.wawuUserId;
    const { target } = resolved;
    // The guard resolves the target from this very body, so the account
    // number is the one asked; anything else throws before a send is claimed.
    if (target.accountNumber !== dto.accountNumber) {
      throw new Error('sendToBank: the resolved target is not the one asked.');
    }
    const note = dto.note?.trim() ? dto.note.trim() : null;
    const fee = this.fees.check(
      payer,
      { kind: 'bank_transfer', amountKobo: dto.amountKobo },
      dto.expectedTotalKobo,
      dto.quoteToken,
      new Date(),
    );

    // The provider's balance, never ours: a 503 or a 423 here moves nothing.
    const { availableKobo } = await this.balances.balance(wallet);
    if (availableKobo < fee.totalKobo) {
      throw insufficientFunds(availableKobo, fee.totalKobo);
    }

    const id = randomUUID();
    const now = new Date();
    const data: Prisma.WalletTransferCreateInput = {
      id,
      kind: 'bank_account',
      payerWawuUserId: payer,
      bankCode: target.bankCode,
      bankName: target.bankName,
      bankAccountNumber: target.accountNumber,
      bankAccountName: target.accountName,
      amountKobo: BigInt(dto.amountKobo),
      providerFeeKobo: BigInt(fee.fee.providerFeeKobo),
      wawuFeeKobo: BigInt(fee.fee.wawuFeeKobo),
      totalKobo: BigInt(fee.totalKobo),
      note,
      customerReference: `${BANK_SEND_REFERENCE_PREFIX}${id}`,
      payerAccountNumber: wallet.accountNumber,
      provider: this.provider.name,
      status: 'pending',
      nextCheckAt: new Date(now.getTime() + MINUTE),
      sentAt: now,
    };

    // The CLAIM, as for a send to a WAWU user: the row, its pending ledger
    // row and the key's link to it, in one transaction, before the provider
    // is called.
    const transfer = await this.claim(scope, data);

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.bankTransfer({
        from: { kind: 'customer', customerId: wallet.customerId },
        accountNumber: target.accountNumber,
        accountName: target.accountName,
        bankCode: target.bankCode,
        amountKobo: BigInt(dto.amountKobo),
        reference: transfer.customerReference,
        narration: TRANSFER_NARRATION,
        payee: target.payee,
      });
    } catch (e) {
      return this.afterRefusal(transfer, scope, e, wallet);
    }
    const view = await this.afterReceipt(transfer, scope, receipt);
    await this.keepPayee(payer, resolved, receipt.payee);
    return view;
  }

  /**
   * Keeps the payee ids a send used or made on the saved place it went to, so
   * the next send reuses them. Never fails the send: the money has moved.
   */
  private async keepPayee(
    payer: string,
    resolved: ResolvedBankTarget,
    payee: ProviderTransferReceipt['payee'],
  ): Promise<void> {
    const { place, target } = resolved;
    if (!place || !payee) return;
    try {
      if (place.kind === 'beneficiary') {
        await this.saved.rememberBeneficiaryPayee(payer, place.id, payee);
      } else {
        await this.saved.rememberPayoutPayee(
          payer,
          'person',
          { bankCode: place.bankCode, accountNumber: target.accountNumber },
          payee,
        );
      }
    } catch (e) {
      this.logger.warn(
        `bank send: the payee ids could not be kept (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /**
   * Writes the send. READ COMMITTED (Postgres's default; nothing here raises
   * it): WAWU's limits take a per-person lock for this transaction and count
   * the person's sends today and this month, so two sends by one person are
   * checked one after the other and the second sees the first one's pending
   * ledger row (NUV-07).
   */
  private async claim(
    scope: IdempotencyScope,
    data: Prisma.WalletTransferCreateInput,
  ): Promise<TransferRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.limits.assertMayMove(
        {
          wawuUserId: data.payerWawuUserId!,
          kind: (data.kind === 'bank_account'
            ? 'bank_transfer'
            : 'wawu_transfer') satisfies MoneyLimitKind,
          amountKobo: koboNumber(BigInt(data.amountKobo)),
        },
        { tx },
      );
      await this.keys.attach(tx, scope, data.id!);
      const row = await tx.walletTransfer.create({ data });
      await this.ledger.record(this.movement(row, 'out', 'pending'), tx);
      return row;
    });
  }

  /** The names both people go by on the other's history: WAWU ID's, else the wallet's. */
  private async namesOf(
    payer: string,
    recipient: TransferRecipient,
  ): Promise<{ payer: string | null; recipient: string | null }> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: payer },
      select: { accountName: true },
    });
    const fallback = new Map<string, string>();
    if (wallet?.accountName?.trim()) fallback.set(payer, wallet.accountName);
    if (recipient.accountName?.trim()) {
      fallback.set(recipient.wawuUserId, recipient.accountName);
    }
    const parties = await this.partiesOf(
      [payer, recipient.wawuUserId],
      fallback,
    );
    const named = (id: string) => parties.get(id)?.displayName?.trim() || null;
    return { payer: named(payer), recipient: named(recipient.wawuUserId) };
  }

  /**
   * Name, handle, avatar and tick for each person, from WAWU ID and the
   * profiles. WAWU ID not answering in time never holds up an answer about
   * money that has moved: the names then come from our own records.
   */
  private async partiesOf(
    ids: string[],
    fallback: ReadonlyMap<string, string>,
  ): Promise<Map<string, MoneyPartyView>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        loadMoneyParties(this.prisma, this.wawuId, ids, fallback),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), PARTY_WAIT_MS);
        }),
      ]);
    } catch {
      const rows = await this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: ids } },
        select: { wawuUserId: true, handle: true, avatarUrl: true },
      });
      const out = new Map<string, MoneyPartyView>();
      for (const r of rows) {
        out.set(r.wawuUserId, {
          wawuUserId: r.wawuUserId,
          displayName: fallback.get(r.wawuUserId)?.trim() || r.handle || '',
          handle: r.handle ?? null,
          avatarUrl: r.avatarUrl ?? null,
          tick: null,
        });
      }
      return out;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The provider did not take the send, or we do not know whether it did. */
  private async afterRefusal(
    transfer: TransferRow,
    scope: IdempotencyScope,
    e: unknown,
    wallet: OpenWallet,
  ): Promise<TransferView> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (refusal?.requestNotSent) {
      // The request PROVABLY never reached the provider (a refused
      // connection, a host name that did not resolve): it has no record of
      // it, so nothing moved. The send is failed and the key given back; the
      // same key sends it again as a new send, under a new reference.
      this.logger.warn(
        `send ${transfer.id}: ${this.provider.label} could not be reached (the request was not sent); the key is given back`,
      );
      await this.markFailed(transfer, TRANSFER_FAILED_REASON);
      await this.keys.release(scope);
      throw refusal.toHttpException();
    }
    if (
      !refusal ||
      (refusal.recordMayExist && !NO_TRANSFER_REFUSALS.includes(refusal.kind))
    ) {
      // Money may have moved (a lost answer, or a transfer the provider
      // accepted and has not completed). Pending until the provider says;
      // nothing is sent again from here.
      this.logger.warn(
        `send ${transfer.id}: outcome unknown (${refusal?.kind ?? 'error'}); pending until ${this.provider.label} says`,
      );
      return this.answer(scope, await this.reload(transfer));
    }
    const failed = await this.markFailed(transfer, TRANSFER_FAILED_REASON);
    if (
      RELEASED.includes(refusal.kind) ||
      refusal instanceof WalletProviderLimitError
    ) {
      // Nothing moved and the person can fix the cause: the key is given
      // back so the same send can be tried again (CONVENTIONS section 4).
      await this.keys.release(scope);
      if (refusal.kind === 'insufficient_funds') {
        throw insufficientAfterProviderRefusal(
          await this.balanceOrNull(wallet),
          koboNumber(transfer.totalKobo),
        );
      }
      throw refusal.toHttpException();
    }
    this.logger.warn(
      `send ${transfer.id}: ${this.provider.label} refused it (${refusal.kind}); nothing moved`,
    );
    return this.answer(scope, failed);
  }

  /**
   * The provider completed the transfer and said what it took. Its figures
   * are compared as the integers they are (bigint kobo): the amount moved is
   * the amount asked, or the send is stopped for review.
   */
  private async afterReceipt(
    transfer: TransferRow,
    scope: IdempotencyScope,
    receipt: ProviderTransferReceipt,
  ): Promise<TransferView> {
    if (receipt.amountKobo !== transfer.amountKobo) {
      // The provider moved another amount than asked: a stop. The ledger is
      // not written with a figure we did not ask for; a person looks.
      this.logger.error(
        `send ${transfer.id}: ${this.provider.label} moved another amount than asked; sent to review`,
      );
      const row = await this.toReview(
        transfer,
        `amountKobo ${transfer.amountKobo} vs ${receipt.amountKobo}`,
      );
      return this.answer(scope, row);
    }
    // The provider took it: W19's "sent to your bank".
    await this.markSentToBank(transfer, new Date());
    let row: TransferRow;
    try {
      row = await this.completeFromRecord(transfer, {
        amountKobo: receipt.amountKobo,
        feeKobo: receipt.feeKobo,
        totalKobo: receipt.totalKobo,
        refs: {
          fintavaReference: receipt.providerReference,
          tagapayTransRef: receipt.secondaryReference,
          fintavaTransactionId: receipt.transactionId,
        },
        source: 'send',
        occurredAt: null,
        debitRecorded: false,
      });
    } catch (e) {
      // The money moved and our record of it did not finish (a lost database
      // connection): the send stays pending, the sweep finishes it from the
      // provider's record. Never a 500 for money that has moved.
      this.logger.error(
        `send ${transfer.id}: the provider took it but it could not be completed here (${e instanceof Error ? e.name : 'error'}); the sweep finishes it`,
      );
      row = await this.reload(transfer);
    }
    return this.answer(scope, row);
  }

  /**
   * THE one place a send is completed: from the provider's answer to the
   * send, from the sweep's lookup, and from a ledger row some other job
   * settled (the ledger's status check, a webhook). The provider's own
   * record decides the figures (`completedFigures`), never the quote when the
   * provider said otherwise:
   * - **as quoted**: both ledger rows complete, the send completes.
   * - **below the quote**: the sender's row takes the real charge and
   *   completes (nobody is owed anything), the send records the real
   *   figures and the difference on `discrepancy`.
   * - **above the quote, believably**: the money left the wallet at the
   *   provider's figures, so the row takes them and completes; the send
   *   records the real total and is flagged for review (`debitReviewSince`).
   * - **not believed** (a charge below 0, or above the quote by more than
   *   PAYMENT_CHARGE_REVIEW_ABOVE_KOBO): the send is stopped for review, still
   *   `pending`, and no figure of the provider's is written.
   * The receiver's `in` row is written on this path only, so a completed send
   * always has both rows and a pending one has only the sender's.
   */
  private async completeFromRecord(
    seen: TransferRow,
    rec: {
      amountKobo: bigint;
      feeKobo: bigint | null;
      totalKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      source: 'send' | 'lookup' | 'history' | 'webhook';
      occurredAt: Date | null;
      /** The sender's row is already the record (it is what settled the send). */
      debitRecorded: boolean;
    },
  ): Promise<TransferRow> {
    const t = await this.prisma.walletTransfer.findUniqueOrThrow({
      where: { id: seen.id },
    });
    if (t.status !== 'pending') return t;
    const quotedFee = t.providerFeeKobo + t.wawuFeeKobo;
    const figures = completedFigures(
      { providerFeeKobo: quotedFee, totalKobo: t.totalKobo },
      rec,
      this.provider.label,
      BigInt(this.settings.chargeReviewAboveKobo),
    );
    if (figures.verdict === 'untrusted') {
      return this.toReview(t, figures.note ?? 'charge not trusted');
    }
    const amount = koboNumber(t.amountKobo);
    const split = splitCharge(
      {
        providerFeeKobo: koboNumber(t.providerFeeKobo),
        wawuFeeKobo: koboNumber(t.wawuFeeKobo),
      },
      koboNumber(figures.feeKobo),
    );
    const real = {
      amountKobo: amount,
      feeKobo: koboNumber(figures.feeKobo),
      totalKobo: koboNumber(figures.totalKobo),
      ...split,
    };
    const sighted = <M extends LedgerMovementInput>(m: M): M => ({
      ...m,
      source: rec.source,
      ...(rec.occurredAt ? { occurredAt: rec.occurredAt } : {}),
    });
    const notes: string[] = [];
    if (!rec.debitRecorded) {
      if (figures.verdict !== 'as_quoted') {
        // The sender's row was written with the quoted charge; the money
        // left the wallet at the provider's, above or below, so the row takes
        // the provider's figures and completes.
        await this.ledger.completeDebitAt(
          { transferId: t.id },
          { feeKobo: quotedFee, totalKobo: t.totalKobo },
          { feeKobo: figures.feeKobo, totalKobo: figures.totalKobo },
          rec.source,
        );
      }
      const out = await this.ledger.record(
        {
          ...sighted(this.movement(t, 'out', 'completed', real, rec.refs)),
          // A record that gives no charge (Fintava's lookups and history)
          // says nothing against the figures the row holds now.
          figuresStand: rec.feeKobo === null && rec.totalKobo === null,
        },
        undefined,
        { quiet: true },
      );
      if (out.discrepancy) notes.push(out.discrepancy);
    }
    // A send to a bank has no receiver's side of ours: the money is at
    // another bank. Only a send to a WAWU user writes the receiver's row.
    if (t.kind !== 'bank_account') {
      const inn = await this.ledger.record(
        sighted(
          this.movement(
            t,
            'in',
            'completed',
            {
              ...real,
              feeKobo: 0,
              totalKobo: amount,
              providerFeeKobo: 0,
              wawuFeeKobo: 0,
            },
            rec.refs,
          ),
        ),
        undefined,
        { quiet: true },
      );
      if (inn.discrepancy) notes.push(inn.discrepancy);
    }

    const above = figures.verdict === 'above';
    if (above) {
      this.logger.error(`send ${t.id}: ${figures.note}; flagged for review`);
    }
    const now = new Date();
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'pending' },
      data: {
        status: 'completed',
        completedAt: now,
        nextCheckAt: null,
        reviewSince: null,
        ...(t.kind === 'bank_account' && t.sentToBankAt === null
          ? { sentToBankAt: rec.occurredAt ?? now }
          : {}),
        providerFeeKobo: BigInt(real.providerFeeKobo),
        wawuFeeKobo: BigInt(real.wawuFeeKobo),
        totalKobo: BigInt(real.totalKobo),
        ...(above ? { debitReviewSince: t.debitReviewSince ?? now } : {}),
        ...(joinNotes(t.discrepancy, figures.note, ...notes)
          ? { discrepancy: joinNotes(t.discrepancy, figures.note, ...notes) }
          : {}),
      },
    });
    return this.prisma.walletTransfer.findUniqueOrThrow({
      where: { id: t.id },
    });
  }

  // -------------------------------------------------------------------------
  // Settling sends whose answer was lost
  // -------------------------------------------------------------------------

  /**
   * Every minute: every pending send due a check (not under review), in the
   * order of its next check, paged by key so none waits behind another. A
   * send still unknown after a check is asked again later (1, 2, 4 ...
   * minutes, at most an hour), and goes to review past
   * PAYMENT_REVIEW_AFTER_HOURS. Nothing here ever sends.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-transfer-settle' })
  async sweep(now = new Date()): Promise<{ checked: number; settled: number }> {
    const counts = { checked: 0, settled: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      let after: { at: Date; id: string } | null = null;
      for (let page = 0; page < SWEEP_PAGES; page += 1) {
        const where: Prisma.WalletTransferWhereInput = {
          status: 'pending',
          reviewSince: null,
          nextCheckAt: { lte: now },
        };
        if (after) {
          where.OR = [
            { nextCheckAt: { gt: after.at } },
            { nextCheckAt: after.at, id: { gt: after.id } },
          ];
        }
        const due = await this.prisma.walletTransfer.findMany({
          where,
          orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_PAGE,
          select: { id: true, nextCheckAt: true },
        });
        for (const { id } of due) {
          counts.checked += 1;
          const status = await this.settle(id, now, true);
          if (status !== null && status !== 'pending') counts.settled += 1;
        }
        if (due.length < SWEEP_PAGE) break;
        const last = due[due.length - 1];
        after = { at: last.nextCheckAt!, id: last.id };
      }
    } catch (e) {
      this.logger.error(
        `send sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /**
   * Settles one pending send from what is known: the sender's ledger row when
   * that is settled, else the provider itself (`reconcileSend`: by our
   * reference, then the sender's history). `ask`: whether to ask the provider
   * (the sweep) or only read the ledger (the ledger listener). A send another
   * provider took (written before a switch of WALLET_PROVIDER) is never asked
   * of this one: this provider's silence about it says nothing. It waits on
   * its ledger rows and goes to review past the bound.
   */
  async settle(
    transferId: string,
    now = new Date(),
    ask = false,
  ): Promise<TransferStatus | null> {
    const t = await this.prisma.walletTransfer.findUnique({
      where: { id: transferId },
    });
    if (!t) return null;
    if (t.status === 'failed' && t.kind === 'bank_account') {
      // A failed bank send arrives as the provider's reversal of the debit
      // (MONEY-07): the sender's row became `reversed` after the send was
      // failed, and the send follows it, once.
      return (await this.followReversal(t)).status as TransferStatus;
    }
    if (t.status !== 'pending') return t.status as TransferStatus;
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: t.customerReference,
        direction: 'out',
        walletKind: 'user',
      },
    });
    if (row?.discrepancy && row.discrepancy !== t.discrepancy) {
      await this.prisma.walletTransfer.update({
        where: { id: t.id },
        data: { discrepancy: row.discrepancy.slice(0, 1000) },
      });
    }
    if (row?.status === 'completed') {
      // Some other job settled the sender's row (the status check, a
      // webhook): that row is the provider's record, and the send completes
      // from it the same way every other path does, the receiver's side
      // included.
      return (
        await this.completeFromRecord(t, {
          amountKobo: row.amountKobo,
          feeKobo: row.feeKobo,
          totalKobo: row.totalKobo,
          refs: {
            fintavaReference: row.fintavaReference,
            tagapayTransRef: row.tagapayTransRef,
            fintavaTransactionId: row.fintavaTransactionId,
          },
          source: 'lookup',
          occurredAt: null,
          debitRecorded: true,
        })
      ).status as TransferStatus;
    }
    if (row?.status === 'reversed') {
      return (await this.toReversed(t)).status as TransferStatus;
    }
    if (
      row?.status === 'failed' &&
      row.failureReason === LEDGER_FINTAVA_FAILURE
    ) {
      return (await this.markFailed(t, TRANSFER_FAILED_REASON, false))
        .status as TransferStatus;
    }
    // Pending, a disagreement held for review, or failed only because the
    // provider had no record of it yet: never proof that no money moved.
    // The provider is asked.
    if (!ask) return 'pending';
    const answer = await this.askProvider(t);
    if (answer?.state === 'found') {
      const found = answer.transaction;
      await this.markSentToBank(t, occurredOf(found) ?? now);
      if (found.outcome === 'completed') {
        if (found.amountKobo !== t.amountKobo) {
          return (
            await this.toReview(
              t,
              `${this.provider.label} moved ${found.amountKobo} kobo for a send of ${t.amountKobo}`,
            )
          ).status as TransferStatus;
        }
        // The provider's record decides the figures: its charge when the
        // record carries one (Nuvion's `applicable_fee`), else the quote.
        return (
          await this.completeFromRecord(t, {
            amountKobo: found.amountKobo,
            feeKobo: found.feeKobo ?? null,
            totalKobo: null,
            refs: refsOf(found),
            source: answer.source,
            occurredAt: occurredOf(found),
            debitRecorded: false,
          })
        ).status as TransferStatus;
      }
      if (found.outcome === 'failed') {
        await this.recordSighting(t, 'failed', found, answer.source);
        return (await this.markFailed(t, TRANSFER_FAILED_REASON, false))
          .status as TransferStatus;
      }
      if (found.outcome === 'reversed') {
        if (found.amountKobo !== t.amountKobo) {
          return (
            await this.toReview(
              t,
              `${this.provider.label} reversed ${found.amountKobo} kobo for a send of ${t.amountKobo}`,
            )
          ).status as TransferStatus;
        }
        await this.recordSighting(t, 'reversed', found, answer.source);
        this.logger.warn(
          `send ${t.id}: ${this.provider.label} reversed the transfer; the money went back to the sender`,
        );
        return (await this.toReversed(t)).status as TransferStatus;
      }
      // Any other word (null: a status we do not know) says neither: still
      // pending, asked again later, and to review past the bound. Never read
      // as "no money moved".
    }
    await this.reschedule(t, now);
    return 'pending';
  }

  /**
   * What the provider knows of the send's transfer, or null when it cannot
   * be asked: the send is another provider's, the sender's wallet is gone, or
   * the provider did not answer.
   */
  private async askProvider(
    t: TransferRow,
  ): Promise<ProviderReconciliation | null> {
    if (t.provider !== this.provider.name) return null;
    const wallet = t.payerAccountNumber
      ? await this.prisma.fintavaWallet.findUnique({
          where: { accountNumber: t.payerAccountNumber },
          select: { customerId: true, provider: true },
        })
      : null;
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) return null;
    try {
      return await this.provider.reconcileSend(
        t.customerReference,
        { kind: 'customer', customerId: wallet.customerId },
        t.sentAt ?? t.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `send ${t.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
      return null;
    }
  }

  /**
   * The provider's record of a transfer that FAILED or was REVERSED onto the
   * sender's ledger row (a revival when the row was failed as absent). No
   * money is owed on either, so the charge is not compared.
   */
  private async recordSighting(
    t: TransferRow,
    status: 'failed' | 'reversed',
    found: ProviderTransaction,
    source: 'lookup' | 'history',
  ): Promise<void> {
    if (!t.payerAccountNumber) return;
    try {
      await this.ledger.record(
        {
          ...this.movement(
            t,
            'out',
            status,
            {
              amountKobo: koboNumber(t.amountKobo),
              feeKobo: koboNumber(t.providerFeeKobo + t.wawuFeeKobo),
              totalKobo: koboNumber(t.totalKobo),
              providerFeeKobo: koboNumber(t.providerFeeKobo),
              wawuFeeKobo: koboNumber(t.wawuFeeKobo),
            },
            refsOf(found),
          ),
          source,
          occurredAt: occurredOf(found),
          failureReason: status === 'failed' ? LEDGER_FINTAVA_FAILURE : null,
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `send ${t.id}: the ledger could not record ${this.provider.label}'s record (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** Still unknown: asked again later, or sent to review past the bound. */
  private async reschedule(t: TransferRow, now: Date): Promise<void> {
    const sent = (t.sentAt ?? t.createdAt).getTime();
    if (now.getTime() - sent >= this.settings.reviewAfterHours * 3_600_000) {
      await this.toReview(
        t,
        t.provider === this.provider.name
          ? `no answer from ${this.provider.label} after ${this.settings.reviewAfterHours} hours`
          : `taken by ${t.provider}, which this server does not run (WALLET_PROVIDER=${this.provider.name}); no answer after ${this.settings.reviewAfterHours} hours`,
      );
      return;
    }
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'pending' },
      data: {
        checks: { increment: 1 },
        nextCheckAt: new Date(
          now.getTime() + nextSendCheckDelayMs(t.checks + 1),
        ),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Reading one send (W12, W14)
  // -------------------------------------------------------------------------

  /**
   * One send as it stands now (`GET /money/transfers/{id}`): what the app
   * polls after a `pending` answer. Only the sender reads it: someone else's
   * send, and an id nobody holds, are the same `404 not_found`. It reads our
   * own record only (the sweep, the ledger's settlement and the webhooks are
   * what move a send on) and never asks the provider.
   */
  async read(wallet: OpenWallet, id: string): Promise<TransferView> {
    const t = await this.prisma.walletTransfer.findFirst({
      where: { id, payerWawuUserId: wallet.wawuUserId },
    });
    if (!t) throw new MoneyError('not_found', TRANSFER_NOT_FOUND_MESSAGE);
    return this.view(t);
  }

  async view(t: TransferRow): Promise<TransferView> {
    const status = t.status as TransferStatus;
    const providerFeeKobo = koboNumber(t.providerFeeKobo);
    const wawuFeeKobo = koboNumber(t.wawuFeeKobo);
    const bank = t.kind === 'bank_account';
    const [party, ledgerRow] = await Promise.all([
      bank ? Promise.resolve(null) : this.recipientParty(t),
      this.senderRow(t),
    ]);
    const timeline: TransferTimelineEntry[] = [
      { step: 'requested', at: t.createdAt.toISOString() },
    ];
    // A send that failed or was reversed was not "sent to the bank" as far as
    // the person is concerned (round 2): the step is for a send the bank took.
    if (
      bank &&
      t.sentToBankAt &&
      status !== 'failed' &&
      status !== 'reversed'
    ) {
      timeline.push({ step: 'sent_to_bank', at: t.sentToBankAt.toISOString() });
    }
    if (t.completedAt) {
      timeline.push({ step: 'completed', at: t.completedAt.toISOString() });
    }
    if (status === 'failed' && t.failedAt) {
      timeline.push({ step: 'failed', at: t.failedAt.toISOString() });
    }
    if (status === 'reversed' && t.reversedAt) {
      timeline.push({ step: 'reversed', at: t.reversedAt.toISOString() });
    }
    return {
      id: t.id,
      kind: bank ? 'bank_account' : 'wawu_user',
      status,
      amountKobo: koboNumber(t.amountKobo),
      fee: {
        providerFeeKobo,
        wawuFeeKobo,
        totalFeeKobo: providerFeeKobo + wawuFeeKobo,
      },
      totalKobo: koboNumber(t.totalKobo),
      note: t.note,
      reference: t.customerReference,
      toWawuUser: party,
      toBankAccount: bank ? this.bankAccountOf(t) : null,
      timeline,
      failureReason:
        status === 'failed'
          ? (t.failureReason ?? TRANSFER_FAILED_REASON)
          : status === 'reversed'
            ? TRANSFER_REVERSED_REASON
            : null,
      reversal: this.reversalOf(t, ledgerRow),
      statusMessage:
        status === 'pending' ? SEND_STILL_CONFIRMING_MESSAGE : null,
      transactionId: ledgerRow?.id ?? null,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    };
  }

  /** Where a bank send went, as the bank named it; null when the row holds none. */
  private bankAccountOf(t: TransferRow): BankAccountView | null {
    if (
      t.bankCode === null ||
      t.bankName === null ||
      t.bankAccountNumber === null ||
      t.bankAccountName === null
    ) {
      return null;
    }
    return {
      bankCode: t.bankCode,
      bankName: t.bankName,
      accountNumber: t.bankAccountNumber,
      accountName: t.bankAccountName,
    };
  }

  /** What came back after a reversal, from the provider's own report on the sender's row; null when it gave none. */
  private reversalOf(
    t: TransferRow,
    row: { reversalTotalKobo: bigint | null; reversedAt: Date | null } | null,
  ): TransferReversalView | null {
    if (t.status !== 'reversed' || !row?.reversalTotalKobo) return null;
    const returnedKobo = koboNumber(row.reversalTotalKobo);
    const totalKobo = koboNumber(t.totalKobo);
    return {
      returnedKobo,
      keptKobo: Math.max(0, totalKobo - returnedKobo),
      reversedAt: (row.reversedAt ?? t.reversedAt ?? t.updatedAt).toISOString(),
    };
  }

  /** The sender's row in the history: the id the receipt routes are keyed by. */
  private async senderRow(t: TransferRow) {
    if (!t.payerWawuUserId) return null;
    return this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: t.customerReference,
        walletKind: 'user',
        direction: 'out',
        wawuUserId: t.payerWawuUserId,
      },
      select: { id: true, reversalTotalKobo: true, reversedAt: true },
    });
  }

  private async recipientParty(t: TransferRow): Promise<MoneyPartyView | null> {
    if (!t.recipientWawuUserId) return null;
    const parties = await this.partiesOf(
      [t.recipientWawuUserId],
      new Map(
        t.recipientName ? [[t.recipientWawuUserId, t.recipientName]] : [],
      ),
    );
    return parties.get(t.recipientWawuUserId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  /** The provider's available balance, or null when it did not answer. */
  private async balanceOrNull(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'walletId'>,
  ): Promise<number | null> {
    try {
      return (await this.balances.balance(wallet)).availableKobo;
    } catch {
      return null;
    }
  }

  /** One side of the send, as the ledger records it. */
  private movement(
    t: TransferRow,
    side: 'out' | 'in',
    status: TransferStatus,
    figures?: {
      amountKobo: number;
      feeKobo: number;
      totalKobo: number;
      providerFeeKobo?: number;
      wawuFeeKobo?: number;
    },
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    } = {},
  ): LedgerMovementInput {
    const amount = koboNumber(t.amountKobo);
    const providerFee = koboNumber(t.providerFeeKobo);
    const wawuFee = koboNumber(t.wawuFeeKobo);
    const common = {
      status,
      category: 'transfer' as const,
      narration: TRANSFER_NARRATION,
      references: { customerReference: t.customerReference, ...refs },
      transferId: t.id,
      source: 'send' as const,
      occurredAt: t.sentAt ?? t.createdAt,
      failureReason: status === 'failed' ? t.failureReason : null,
      // No provider here: LedgerService stamps the running provider on every
      // row it creates, and that is this send's own (the sweep acts only on
      // the running provider's sends).
    };
    if (side === 'out') {
      return {
        ...common,
        wallet: {
          kind: 'user',
          wawuUserId: t.payerWawuUserId ?? '',
          accountNumber: t.payerAccountNumber ?? '',
        },
        direction: 'out',
        amountKobo: figures?.amountKobo ?? amount,
        // Before the provider answers: the charges the person was quoted,
        // which is what its record should say. After: its own.
        feeKobo: figures?.feeKobo ?? providerFee + wawuFee,
        totalKobo: figures?.totalKobo ?? amount + providerFee + wawuFee,
        providerFeeKobo: figures?.providerFeeKobo ?? providerFee,
        wawuFeeKobo: figures?.wawuFeeKobo ?? wawuFee,
        counterparty:
          t.kind === 'bank_account'
            ? {
                kind: 'bank_account',
                name: t.bankAccountName,
                accountNumber: t.bankAccountNumber,
                bankCode: t.bankCode,
                bankName: t.bankName,
              }
            : {
                kind: 'wawu_user',
                name: t.recipientName,
                wawuUserId: t.recipientWawuUserId,
                accountNumber: t.recipientAccountNumber,
              },
        note: t.note,
      };
    }
    return {
      ...common,
      wallet: {
        kind: 'user',
        wawuUserId: t.recipientWawuUserId ?? '',
        accountNumber: t.recipientAccountNumber ?? '',
      },
      direction: 'in',
      amountKobo: figures?.amountKobo ?? amount,
      feeKobo: 0,
      totalKobo: figures?.totalKobo ?? amount,
      providerFeeKobo: 0,
      wawuFeeKobo: 0,
      counterparty: {
        kind: 'wawu_user',
        name: t.payerName,
        wawuUserId: t.payerWawuUserId,
        accountNumber: t.payerAccountNumber,
      },
      // The note is the sender's words to the receiver: it travels with the money.
      note: t.note,
    };
  }

  /** A status change that only ever leaves `pending`. */
  private async transition(
    t: TransferRow,
    status: TransferStatus,
    data: Prisma.WalletTransferUpdateManyMutationInput,
  ): Promise<TransferRow> {
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'pending' },
      data: { ...data, status },
    });
    return this.reload(t);
  }

  private reload(t: Pick<TransferRow, 'id'>): Promise<TransferRow> {
    return this.prisma.walletTransfer.findUniqueOrThrow({
      where: { id: t.id },
    });
  }

  /** A bank send the provider took: the time W19's second step shows. Once. */
  private async markSentToBank(t: TransferRow, at: Date): Promise<void> {
    if (t.kind !== 'bank_account') return;
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, sentToBankAt: null },
      data: { sentToBankAt: at },
    });
  }

  /**
   * A failed bank send whose debit the provider has since reversed: the
   * sender's ledger row is `reversed`, so the send is too. Only a `failed`
   * send moves, once (`failed` to `reversed` is the one change a settled
   * send makes).
   */
  private async followReversal(t: TransferRow): Promise<TransferRow> {
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: t.customerReference,
        direction: 'out',
        walletKind: 'user',
      },
      select: { status: true, reversedAt: true },
    });
    if (row?.status !== 'reversed') return t;
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'failed' },
      data: {
        status: 'reversed',
        reversedAt: row.reversedAt ?? new Date(),
      },
    });
    return this.reload(t);
  }

  /** Still `pending`, out of the sweep, for a person to look at. */
  private async toReview(
    t: TransferRow,
    discrepancy: string,
  ): Promise<TransferRow> {
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'pending' },
      data: {
        reviewSince: new Date(),
        nextCheckAt: null,
        discrepancy: (
          joinNotes(t.discrepancy, discrepancy) ?? discrepancy
        ).slice(0, 1000),
      },
    });
    return this.reload(t);
  }

  private toReversed(t: TransferRow): Promise<TransferRow> {
    return this.transition(t, 'reversed', {
      reversedAt: new Date(),
      nextCheckAt: null,
    });
  }

  private async markFailed(
    t: TransferRow,
    reason: string,
    writeLedger = true,
  ): Promise<TransferRow> {
    const row = await this.transition(t, 'failed', {
      failureReason: reason,
      failedAt: new Date(),
      nextCheckAt: null,
    });
    if (writeLedger && row.status === 'failed') {
      try {
        await this.ledger.record(
          this.movement(row, 'out', 'failed'),
          undefined,
          { quiet: true },
        );
      } catch (e) {
        this.logger.error(
          `send ${t.id}: the ledger could not record the refusal (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    return row;
  }

  /** The answer this request gets, stored for every repeat of its key. */
  private async answer(
    scope: IdempotencyScope,
    t: TransferRow,
  ): Promise<TransferView> {
    const view = await this.view(t);
    await this.keys.finish(scope, 201, successBody(view));
    return view;
  }
}

function refsOf(t: ProviderTransaction) {
  return {
    fintavaReference: t.providerReference,
    tagapayTransRef: t.secondaryReference,
    fintavaTransactionId: t.id,
  };
}

function occurredOf(t: ProviderTransaction): Date | null {
  return Number.isNaN(Date.parse(t.createdAt)) ? null : new Date(t.createdAt);
}
