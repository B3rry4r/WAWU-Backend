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
  LEDGER_BANK_SEND_FAILURE,
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

/**
 * What the sender's history calls the fee row and its give-back (FIX-98):
 * WAWU's fee, as the receipt names it, and that fee given back. Copy for the
 * person: no em-dash, no provider name.
 */
export const FEE_ROW_NAME = "WAWU's fee";
export const FEE_GIVEN_BACK_NAME = "WAWU's fee given back";

/** Added to a send's reference for the transfer that moves WAWU's fee (FIX-52). */
export const FEE_LEG_SUFFIX = '-fee';
/** Added to the same reference for the transfer that gives the fee back (FIX-52). */
export const FEE_RETURN_SUFFIX = '-fee-back';
/**
 * Added once more for the one new try at giving the fee back, made only when
 * the provider's own record says the first transfer failed (FIX-70): the
 * provider answers a repeat of a reference with that same failed record, so
 * the first reference is spent.
 */
export const FEE_RETURN_RETRY_SUFFIX = '-2';

/**
 * The reference of the transfer that gives a send's fee back: the first try
 * `<send>-fee-back`, the one new try `<send>-fee-back-2`. Both begin with the
 * send's own reference and the first try's suffix, so a fee given back always
 * links to its send.
 */
export function feeBackReference(
  sendReference: string,
  attempt: 1 | 2,
): string {
  return `${sendReference}${FEE_RETURN_SUFFIX}${
    attempt === 2 ? FEE_RETURN_RETRY_SUFFIX : ''
  }`;
}

/** The send a fee-back transfer's reference belongs to, or null when it is not one. */
export function sendReferenceOfFeeBack(reference: string): string | null {
  for (const suffix of [
    `${FEE_RETURN_SUFFIX}${FEE_RETURN_RETRY_SUFFIX}`,
    FEE_RETURN_SUFFIX,
  ]) {
    if (reference.endsWith(suffix) && reference.length > suffix.length) {
      return reference.slice(0, -suffix.length);
    }
  }
  return null;
}

/** Someone else's send is the same 404 as one nobody holds (CONVENTIONS.md section 3). */
export const TRANSFER_NOT_FOUND_MESSAGE = 'We could not find that send.';
/** Only when the provider refused the transfer or said it failed: its word, not our inference. */
export const TRANSFER_FAILED_REASON =
  'The send did not go through. No money left your wallet.';
/**
 * A bank send the provider took and then failed (FIX-54): the money left the
 * wallet and the provider gave it back, so "no money left" would not be true.
 */
export const BANK_SEND_RETURNED_REASON =
  'The bank did not complete this transfer. The money is back in your wallet.';
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
/**
 * A bank send that failed without the provider ever having a record of it is
 * asked about ONCE, between this long after it failed (an orphan record the
 * provider wrote when it refused the send was still pending 37 minutes on,
 * mobile repo docs/fintava/sandbox/14-) and 48 hours after (FIX-41, SWEEP-MONEY
 * F8). A read only: nothing is sent.
 */
const FAILED_SEND_LOOK_AFTER_MS = 60 * MINUTE;
const FAILED_SEND_LOOK_UNTIL_MS = 48 * 60 * MINUTE;
/**
 * How the ledger words a sighting that said a failed row completed
 * (`<source> sighting: status failed vs completed`, LedgerService.merge): the
 * ledger keeps the row failed and notes the disagreement, and this is how a
 * failed bank send learns of it.
 */
const LATE_SUCCESS_SIGHTING = /\bstatus failed vs completed\b/;
/** How long the receipt waits for WAWU ID before it names the person from our own records. */
const PARTY_WAIT_MS = 3_000;

type TransferRow = Prisma.WalletTransferGetPayload<object>;

/**
 * Where WAWU's fee stands before a send goes out (FIX-52). `moved`: its own
 * transfer is finished and took `debitKobo` from the sender. `none`: there is
 * no such transfer on this provider, or the fee is not more than the
 * provider's charge for moving it. `pending`: Nuvion has not finished it, or
 * its answer was lost: the send waits and the fee is never moved twice.
 * `refused`: the provider said it made nothing (`definitive`: for a reason
 * that will not pass, so a send waiting on it is failed).
 */
type FeeStep =
  | { state: 'moved'; debitKobo: bigint }
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'refused'; error: WalletProviderError; definitive: boolean };

/** Refusals of the fee's transfer that a later try would not change. */
const FEE_REFUSALS_FINAL: readonly WalletProviderErrorKind[] = [
  'insufficient_funds',
  'wallet_inactive',
  'refused',
];
/** A fee to give back is looked for this long, then it is left to a person. */
const FEE_RETURN_GIVE_UP_MS = 24 * 60 * MINUTE;
/** The rest between two tries to give a fee back. */
export const FEE_RETURN_RETRY_MS = 2 * MINUTE;
/**
 * The rest between two looks at a fee whose give-back the provider failed
 * twice (FIX-70): nothing is sent in the meantime, and the sweep goes on only
 * until the review bound, when a person takes it.
 */
const FEE_RETURN_REST_MS = 30 * MINUTE;

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
/**
 * Runs inside the send's claim transaction, after the send exists and before
 * the provider is called. Throwing rolls the whole claim back: nothing is
 * sent, no ledger row is left, and the Idempotency-Key is given back.
 */
export type SendClaimHook = (
  tx: Prisma.TransactionClient,
  transferId: string,
) => Promise<void>;

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
    for (const route of [TRANSFER_ROUTE, BANK_TRANSFER_ROUTE]) {
      this.answerStaleKeysFromSend(route);
    }
    // A send's ledger row settled by anything settles the send now.
    // A pending status is a wake (the fee's transfer was delivered): the send
    // goes on, which may ask the provider. Any other status only reads the ledger.
    this.ledger.onTransferSettled((e) =>
      this.settle(e.transferId, new Date(), e.status === 'pending'),
    );
  }

  /**
   * A key left `in_progress` by a request that died (a restart mid-send) is
   * answered from its send once the request can no longer be running. A
   * feature route that sends through `send` registers its own route here
   * (INBOX-15).
   */
  answerStaleKeysFromSend(route: string): void {
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

  // -------------------------------------------------------------------------
  // Sending (W10 to W12)
  // -------------------------------------------------------------------------

  async send(
    wallet: OpenWallet,
    dto: WawuTransferDto,
    scope: IdempotencyScope,
    inClaim?: SendClaimHook,
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
    const transfer = await this.claim(scope, data, inClaim);

    // WAWU's fee moves FIRST (FIX-52): a balance spent while the send is on
    // its way can never evade it. Nothing else moves unless it did.
    const feeStep = await this.takeFee(transfer);
    if (feeStep.state === 'refused') {
      return this.afterRefusal(transfer, scope, feeStep.error, wallet);
    }
    if (feeStep.state === 'pending') {
      return this.answer(scope, await this.reload(transfer));
    }

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

    // WAWU's fee moves first, as for a send to a WAWU user (FIX-52).
    const feeStep = await this.takeFee(transfer);
    if (feeStep.state === 'refused') {
      return this.afterRefusal(transfer, scope, feeStep.error, wallet);
    }
    if (feeStep.state === 'pending') {
      return this.answer(scope, await this.reload(transfer));
    }

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
    inClaim?: SendClaimHook,
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
      const row = await tx.walletTransfer.create({
        data: { ...data, feeTransferDue: this.feeTransferDueNow(data) },
      });
      await this.ledger.record(this.movement(row, 'out', 'pending'), tx);
      // A feature that sends on someone's behalf (INBOX-15: paying a money
      // request) ties its own record to this send HERE, in the claim, so a
      // refusal rolls the send back with it and two sends can never be
      // claimed for one thing.
      if (inClaim) await inClaim(tx, row.id);
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
    if (receipt.pending) {
      // Taken, not finished (FIX-54): the money has left the wallet and the
      // bank may still refuse it, so the send is NOT done. It stays pending
      // until the provider says completed (its delivery settles the sender's
      // ledger row, or the sweep reads the transfer), failed, or reversed.
      // Read again, so a delivery that beat this answer is not hidden.
      return this.answer(scope, await this.reload(transfer));
    }
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
    recIn: {
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
    let rec = recIn;
    const t = await this.prisma.walletTransfer.findUniqueOrThrow({
      where: { id: seen.id },
    });
    if (t.status !== 'pending') return t;
    // WAWU's fee moved before the send did (FIX-52). A record from the
    // provider's answer or lookup states its own charge for the send only, so
    // the fee's transfer, read back, is added; a row the provider's delivery
    // already completed holds it (the handler reads the same record). A fee
    // that was never moved leaves the send at what really left the wallet.
    let feeNote: string | null = null;
    if (this.feeLegDue(t)) {
      const moved = await this.feeLegDebit(t);
      if (moved === 'unsure') {
        // The fee may have been taken: the send is not completed at figures
        // without it. It stays pending, asked again, and to review past the
        // bound (SWEEP-MONEY-4 round 2, F2).
        await this.reschedule(t, new Date());
        return this.reload(t);
      }
      if (moved === null) {
        // Nothing to say when the fee is not more than the provider's charge
        // for moving it (no transfer was due); a fee that was due and is not
        // there is told.
        if (this.feeLegKobo(koboNumber(t.wawuFeeKobo)) > 0) {
          feeNote = "WAWU's fee was not collected";
        }
      } else if (!rec.debitRecorded && rec.feeKobo !== null) {
        const charge = rec.feeKobo;
        const total = rec.totalKobo;
        rec = {
          ...rec,
          feeKobo: charge + moved,
          totalKobo: total === null ? null : total + moved,
        };
      }
    }
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
        ...(joinNotes(t.discrepancy, figures.note, feeNote, ...notes)
          ? {
              discrepancy: joinNotes(
                t.discrepancy,
                figures.note,
                feeNote,
                ...notes,
              ),
            }
          : {}),
      },
    });
    return this.prisma.walletTransfer.findUniqueOrThrow({
      where: { id: t.id },
    });
  }

  // -------------------------------------------------------------------------
  // WAWU's fee on a provider whose own charge cannot carry it (FIX-52)
  // -------------------------------------------------------------------------

  /** Whether this send's WAWU fee is a transfer of its own on this provider. */
  private feeLegDue(t: TransferRow): boolean {
    return (
      this.provider.wawuFeeLeg === true &&
      t.provider === this.provider.name &&
      t.wawuFeeKobo > 0n &&
      t.payerAccountNumber !== null
    );
  }

  /**
   * Whether a transfer of WAWU's fee is due for a send made now (the fee is
   * more than the provider's charge for moving it); written with the send in
   * the claim, so a later schedule cannot change it. Null: no such transfer
   * on this provider (SWEEP-MONEY-5a round 2, F2).
   */
  private feeTransferDueNow(
    data: Prisma.WalletTransferCreateInput,
  ): boolean | null {
    if (this.provider.wawuFeeLeg !== true) return null;
    const fee = BigInt(data.wawuFeeKobo);
    return (
      data.payerAccountNumber != null &&
      fee > 0n &&
      this.feeLegKobo(koboNumber(fee)) > 0
    );
  }

  /**
   * Whether a transfer of WAWU's fee may have been made for this send, from
   * what the send recorded, never today's schedule: only "none due" is false,
   * and a send with nothing recorded counts as due. A lookup that answers
   * `unknown` means "not found" for the first and "unsure" for the rest
   * (SWEEP-MONEY-5a, G2, G3, F2).
   */
  private feeTransferDue(t: TransferRow): boolean {
    return this.feeLegDue(t) && t.feeTransferDue !== false;
  }

  /**
   * What the fee's transfer moves, in kobo. Nuvion charges for moving it on
   * what it moves (a banded schedule charges by band), so the amount is the
   * one whose own charge brings the sender's debit to WAWU's fee, to the
   * kobo where the schedule allows it. At most the fee, at least 0.
   */
  private feeLegKobo(wawuFee: number): number {
    if (!this.fees.feesSet) return wawuFee;
    const charge = (kobo: number) =>
      this.fees.providerFees.walletToWalletKobo(kobo);
    let leg = wawuFee - charge(wawuFee);
    for (let i = 0; i < 6 && leg > 0; i += 1) {
      const next = wawuFee - charge(leg);
      if (next === leg) break;
      leg = next;
    }
    return Math.max(0, Math.min(leg, wawuFee));
  }

  /**
   * Moves WAWU's fee from the sender to WAWU's own account at the provider,
   * BEFORE the send (lead ruling, 17 Oct): one transfer under the send's
   * reference plus `-fee`, which the provider's log and Nuvion both answer
   * with the original when it is asked again, so a replay, a parallel send, a
   * sweep or a late delivery never moves it twice. A balance spent after it
   * can no longer evade it. Nothing is held while the provider answers. The
   * provider's charge for moving it is taken on what it moves, so the person
   * pays the quote to the kobo.
   */
  private async takeFee(t: TransferRow): Promise<FeeStep> {
    if (!this.feeLegDue(t)) return { state: 'none' };
    const wawuFee = koboNumber(t.wawuFeeKobo);
    const leg = this.feeLegKobo(wawuFee);
    if (leg <= 0) {
      this.logger.warn(
        `send ${t.id}: WAWU's fee (${wawuFee} kobo) is not more than ${this.provider.label}'s charge for moving it; not collected`,
      );
      return { state: 'none' };
    }
    try {
      const platform = await this.provider.getPlatformAccount();
      const receipt = await this.provider.walletToWallet({
        fromAccountNumber: t.payerAccountNumber!,
        toAccountNumber: platform.accountNumber,
        amountKobo: BigInt(leg),
        reference: `${t.customerReference}${FEE_LEG_SUFFIX}`,
        narration: TRANSFER_NARRATION,
      });
      // The money is in WAWU's account: its ledger says so too (FIX-66).
      await this.recordFeeLeg(t, platform.accountNumber, receipt.amountKobo);
      return { state: 'moved', debitKobo: receipt.totalKobo };
    } catch (e) {
      if (e instanceof WalletProviderError && !e.recordMayExist) {
        return {
          state: 'refused',
          error: e,
          definitive: FEE_REFUSALS_FINAL.includes(e.kind),
        };
      }
      this.logger.warn(
        `send ${t.id}: WAWU's fee is not confirmed yet (${e instanceof WalletProviderError ? e.kind : 'error'}); the send waits and nothing is sent`,
      );
      return { state: 'pending' };
    }
  }

  /** The provider's record of a transfer under a send's reference plus `suffix`; read only. */
  private async legRecord(
    t: TransferRow,
    suffix: string,
  ): Promise<ProviderTransaction | 'unknown' | null> {
    try {
      const r = await this.provider.findTransactionByReference(
        `${t.customerReference}${suffix}`,
      );
      if (r.state === 'found') return r.transaction;
      return r.state === 'absent' ? null : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * What the fee's transfer took from the sender, null when it took nothing,
   * or `unsure` when the provider's record of it is unfinished or in a status
   * word we do not know: that is never "took nothing" (read only). A lookup
   * that answers `unknown` (the provider could not be read, or never held the
   * transfer: its answer is the same) is `unsure` when a fee transfer was due
   * for this send, so a send is never completed without a fee that was taken;
   * where none was due it is "took nothing" (SWEEP-MONEY-5a, G3).
   */
  private async feeLegDebit(t: TransferRow): Promise<bigint | null | 'unsure'> {
    const rec = await this.legRecord(t, FEE_LEG_SUFFIX);
    if (
      (rec === 'unknown' && this.feeTransferDue(t)) ||
      (rec !== null &&
        rec !== 'unknown' &&
        (rec.outcome === 'pending' || rec.outcome === null))
    ) {
      return 'unsure';
    }
    if (rec !== null && rec !== 'unknown' && rec.outcome === 'completed') {
      // The same row `takeFee` wrote, written again when that write was lost
      // (FIX-66); a row that is there is left as it is.
      await this.recordFeeLeg(t, null, rec.amountKobo);
    }
    if (
      rec === null ||
      rec === 'unknown' ||
      rec.outcome !== 'completed' ||
      rec.feeKobo === null ||
      rec.feeKobo === undefined
    ) {
      return null;
    }
    return rec.amountKobo + rec.feeKobo;
  }

  /**
   * WAWU's account at the provider, as its ledger names it: the number the
   * seam gives (read from the provider, never kept). Null when the provider
   * cannot say now; the caller then leaves the row to its next look.
   */
  private async platformNumber(): Promise<string | null> {
    try {
      return (await this.provider.getPlatformAccount()).accountNumber;
    } catch {
      return null;
    }
  }

  /**
   * The ledger's side of the transfer that moved WAWU's fee (FIX-66): money
   * IN on WAWU's own account, under the fee transfer's reference, the amount
   * that transfer moved (Nuvion's charge on it is the sender's, so it is not
   * in WAWU's account). Without it the operational account's ledger was short
   * of the provider's by the fee of every send. The sender's side is the
   * send's own row, which already carries the fee in its total. Written once
   * (the ledger finds the row by account, direction and reference), only after
   * the provider's record says the transfer completed, and never allowed to
   * undo what has moved: a failure is logged and the next look writes it.
   */
  private async recordFeeLeg(
    t: TransferRow,
    platformNumber: string | null,
    movedKobo: bigint,
  ): Promise<void> {
    try {
      const account = platformNumber ?? (await this.platformNumber());
      if (!account || movedKobo <= 0n) return;
      const amount = koboNumber(movedKobo);
      await this.ledger.record(
        {
          wallet: { kind: 'merchant', accountNumber: account },
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: amount,
          feeKobo: 0,
          totalKobo: amount,
          narration: TRANSFER_NARRATION,
          references: {
            customerReference: `${t.customerReference}${FEE_LEG_SUFFIX}`,
          },
          counterparty: {
            kind: 'wawu_user',
            name: null,
            wawuUserId: t.payerWawuUserId,
            accountNumber: t.payerAccountNumber,
          },
          source: 'send',
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `send ${t.id}: the ledger could not record WAWU's fee transfer (${e instanceof Error ? e.name : 'error'}); written at the next look`,
      );
    }
  }

  /**
   * The ledger's side of the transfer that gave the fee back (FIX-66): money
   * OUT of WAWU's own account, under the reference of the try that landed
   * (`reference`: the provider's own, so its deliveries find the row), at what
   * moved and the charge the provider took from WAWU's account for moving it.
   * Written once, for that try only: a try the provider failed moved nothing
   * and has no row. The person's side is the send's own row (failed, or
   * reversed), which nets what the provider returned.
   */
  private async recordFeeBack(
    t: TransferRow,
    platformNumber: string,
    receipt: ProviderTransferReceipt,
    reference: string,
  ): Promise<void> {
    const amount = koboNumber(receipt.amountKobo);
    const charge = koboNumber(receipt.feeKobo);
    await this.ledger.record(
      {
        wallet: { kind: 'merchant', accountNumber: platformNumber },
        direction: 'out',
        status: 'completed',
        category: 'refund',
        amountKobo: amount,
        feeKobo: charge,
        totalKobo: amount + charge,
        providerFeeKobo: charge,
        wawuFeeKobo: 0,
        narration: TRANSFER_NARRATION,
        references: { customerReference: reference },
        counterparty: {
          kind: 'wawu_user',
          name: null,
          wawuUserId: t.payerWawuUserId,
          accountNumber: t.payerAccountNumber,
        },
        source: 'send',
      },
      undefined,
      { quiet: true },
    );
  }

  /**
   * The person's side of the fee given back (FIX-98): money IN on the
   * sender's wallet, category `refund`, under the give-back's own reference
   * (the try that landed), at the amount that moved. With the merchant's
   * `out` row (`recordFeeBack`) it is the give-back as a pair of rows of its
   * own, as a hold's refund is written (`WalletHoldService.writeLedger`). The
   * sender's fee row (`<send>-fee`) stays `completed`, as Nuvion shows the
   * fee's transfer (`successful`): the give-back is a transfer of its own, so
   * that transfer never turned reversed at Nuvion, and a row turned `reversed`
   * made the sweep write a discrepancy when its delivery came in. The two
   * rows net to nothing, as the provider's balance does. Written once (the
   * ledger finds the row by account, direction and reference). Not written
   * when the fee is carried on a reversed send's own row (FIX-85), which nets
   * what came back itself: that fee row turns `reversed` as before.
   */
  private async recordFeeBackToSender(
    t: TransferRow,
    receipt: ProviderTransferReceipt,
    reference: string,
  ): Promise<void> {
    if (!t.payerWawuUserId || !t.payerAccountNumber) return;
    // Written by an earlier look at this very give-back: nothing more (a
    // later look must not turn the fee row reversed over it).
    const written = await this.ledger.entriesFor(t.payerAccountNumber, 'in', [
      reference,
    ]);
    if (written.length > 0) return;
    const [legId] = await this.ledger.entriesFor(t.payerAccountNumber, 'out', [
      `${t.customerReference}${FEE_LEG_SUFFIX}`,
    ]);
    const leg = legId
      ? await this.prisma.fintavaLedgerEntry.findUnique({
          where: { id: legId },
          select: { status: true },
        })
      : null;
    if (t.status === 'reversed' || leg?.status === 'reversed') {
      await this.noteFeeLegReturned(t, reference);
      return;
    }
    const amount = koboNumber(receipt.amountKobo);
    await this.ledger.record(
      {
        wallet: {
          kind: 'user',
          wawuUserId: t.payerWawuUserId,
          accountNumber: t.payerAccountNumber,
        },
        direction: 'in',
        status: 'completed',
        category: 'refund',
        amountKobo: amount,
        feeKobo: 0,
        totalKobo: amount,
        narration: TRANSFER_NARRATION,
        references: { customerReference: reference },
        counterparty: { kind: 'wawu', name: FEE_GIVEN_BACK_NAME },
        source: 'send',
      },
      undefined,
      { quiet: true },
    );
  }

  /**
   * The sender's side of the fee while it is owed (FIX-70 round 2): a send
   * that failed counts nothing in the ledger, yet the fee's own transfer took
   * the fee out of the wallet and the provider's balance stays short of it
   * until a fee-back lands. So the fee is a row of its own on the sender's
   * wallet, `completed` money OUT under the fee transfer's reference, the
   * amount that transfer moved and the charge on it. It stays `completed`
   * when a fee-back lands, as Nuvion's transfer does: the give-back is a row
   * of its own (`recordFeeBackToSender`, FIX-98). It turns `reversed` only
   * when the send itself turns reversed and carries the fee (below). Written
   * once; a failure is logged and the next look writes it. Never for a send that stands, nor for a reversed one
   * (after or before it completed): its own row carries the fee in its total,
   * less what came back, so a row here would count the fee twice (round 3).
   * A failed send that then turns reversed (FIX-85) has the row already: it is
   * turned `reversed` here, whole, because the send's own row carries the fee
   * from then on (a fee-back that lands later is noted on that row).
   */
  private async recordFeeOwed(
    t: TransferRow,
    leg: ProviderTransaction,
  ): Promise<void> {
    if (!t.payerWawuUserId || !t.payerAccountNumber) return;
    if (t.status === 'reversed') {
      // A fee-back that landed before this is a row of its own (FIX-98): it
      // and the fee row net to nothing, so the fee row stays as it is.
      const back = await this.ledger.entriesFor(
        t.payerAccountNumber,
        'in',
        [1, 2].map((n) => feeBackReference(t.customerReference, n as 1 | 2)),
      );
      if (back.length === 0) {
        await this.noteFeeLegReturned(t, t.customerReference);
      }
      return;
    }
    if (t.status !== 'failed') return;
    try {
      const amount = koboNumber(leg.amountKobo);
      const charge = koboNumber(leg.feeKobo ?? 0n);
      await this.ledger.record(
        {
          wallet: {
            kind: 'user',
            wawuUserId: t.payerWawuUserId,
            accountNumber: t.payerAccountNumber,
          },
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: amount,
          feeKobo: charge,
          totalKobo: amount + charge,
          narration: TRANSFER_NARRATION,
          references: {
            customerReference: `${t.customerReference}${FEE_LEG_SUFFIX}`,
          },
          counterparty: { kind: 'wawu', name: FEE_ROW_NAME },
          source: 'send',
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `send ${t.id}: the ledger could not record the fee that is owed (${e instanceof Error ? e.name : 'error'}); written at the next look`,
      );
    }
  }

  /** The fee-back landed: the sender's fee row turns `reversed`, whole (FIX-70 round 2). */
  private async noteFeeLegReturned(
    t: TransferRow,
    reference: string,
  ): Promise<void> {
    if (!t.payerWawuUserId) return;
    await this.ledger.noteFeeLegReturned(
      {
        customerReference: `${t.customerReference}${FEE_LEG_SUFFIX}`,
        wawuUserId: t.payerWawuUserId,
      },
      { reference, at: new Date() },
    );
  }

  /**
   * The move that gives the fee back, under at most two references (FIX-70).
   * It is made under `<send>-fee-back`. Only when the provider's OWN record
   * under that reference says the transfer failed (it took the transfer and
   * failed it: `providerFailed`, then confirmed by reading the record) is the
   * reference spent, because the provider answers a repeat of it with that
   * same failed record; the move is then made once more under
   * `<send>-fee-back-2`, and never in the pass that saw the failure
   * (FIX-70 round 2): `wait` is returned, nothing more is sent, and a later
   * pass, at least `FEE_RETURN_RETRY_MS` after the failed transfer was made,
   * sends the new one. A timeout, a network error, a 5xx, a transfer the
   * provider has not finished or a state it does not say never starts a new
   * reference: those throw, and the same reference is asked about again
   * later. `rest`: both references failed at the provider, so nothing more is
   * sent and a person takes it past the review bound.
   */
  private async moveFeeBack(
    t: TransferRow,
    platformNumber: string,
    owedKobo: bigint,
    now: Date,
  ): Promise<'landed' | 'wait' | 'rest'> {
    // Read only. A first try the provider already failed, in a pass before
    // this one, is spent; one it failed a moment ago is not acted on yet.
    const earlier = await this.legRecord(t, FEE_RETURN_SUFFIX);
    const spent =
      earlier !== 'unknown' && earlier !== null && earlier.outcome === 'failed';
    if (spent && !this.oldEnoughForNewTry(earlier, now)) return 'wait';
    for (const attempt of spent ? ([2] as const) : ([1, 2] as const)) {
      const reference = feeBackReference(t.customerReference, attempt);
      try {
        const receipt = await this.provider.walletToWallet({
          fromAccountNumber: platformNumber,
          toAccountNumber: t.payerAccountNumber!,
          amountKobo: owedKobo,
          reference,
          narration: TRANSFER_NARRATION,
        });
        await this.recordFeeBack(t, platformNumber, receipt, reference);
        await this.recordFeeBackToSender(t, receipt, reference);
        return 'landed';
      } catch (e) {
        if (!(e instanceof WalletProviderError) || !e.providerFailed) throw e;
        // The error is built from the provider's record; the record itself
        // is read before a new reference is used. Anything but `failed`
        // (unreadable, none, pending) stands as the error: asked again.
        const rec = await this.legRecord(
          t,
          attempt === 1
            ? FEE_RETURN_SUFFIX
            : `${FEE_RETURN_SUFFIX}${FEE_RETURN_RETRY_SUFFIX}`,
        );
        if (rec === 'unknown' || rec === null || rec.outcome !== 'failed') {
          throw e;
        }
        this.logger.warn(
          `send ${t.id}: ${this.provider.label} took the fee given back and failed it (try ${attempt}); ${
            attempt === 1
              ? 'trying once more under a new reference in a later pass'
              : 'it failed twice, nothing more is sent'
          }`,
        );
        // Failed in this very pass: the new reference waits for a later one.
        if (attempt === 1) return 'wait';
      }
    }
    return 'rest';
  }

  /**
   * Whether a transfer the provider failed was made long enough ago that a
   * new reference may follow it: at least the sweep's interval, by the
   * provider's own time for it. A time it does not give does not hold the
   * fee back (the pass that saw the failure never sends the new one).
   */
  private oldEnoughForNewTry(rec: ProviderTransaction, now: Date): boolean {
    const made = rec.createdAt ? Date.parse(rec.createdAt) : Number.NaN;
    return Number.isNaN(made) || now.getTime() - made >= FEE_RETURN_RETRY_MS;
  }

  /**
   * Gives the fee back to a sender whose send did not stand (failed, or
   * reversed before or after it completed): the person gets every naira back,
   * Nuvion's charges on both transfers are WAWU's. One transfer under the
   * send's reference plus `-fee-back`, from WAWU's account, made once however
   * often it is asked; if the provider took it and failed it, once more under
   * a new reference in a later pass (`moveFeeBack`, FIX-70). `none`: no fee was
   * taken. `pending`: not finished yet. `rest`: failed twice at the provider.
   * `review`: the fee's own transfer was still unfinished, or in a word we do
   * not know, a day after the fee became owed; `missing`: the provider could
   * not find it, or not be read for it, for a day. A person takes either, the
   * fee still owed (SWEEP-MONEY-4 round 2, F1; SWEEP-MONEY-5a, G1 and G2).
   */
  private async returnFee(
    t: TransferRow,
    now: Date,
  ): Promise<'done' | 'none' | 'pending' | 'rest' | 'review' | 'missing'> {
    if (!this.feeLegDue(t)) return 'none';
    const rec = await this.legRecord(t, FEE_LEG_SUFFIX);
    // A day from when the fee became owed (the failure, or the reversal the
    // Hub learned), by the sweep's own clock (a spec reaches it). Counted from
    // the send, a late reversal made its first look already "old" and one
    // unreadable answer sent it straight to a person (G1).
    const old = now.getTime() - this.feeOwedSince(t) > FEE_RETURN_GIVE_UP_MS;
    // The provider cannot say (unreadable, or it never held the transfer: its
    // answer is the same). Where no fee transfer was due there is nothing to
    // give back, and nothing reaches a person (G2). Where one was due, it is
    // asked again for a day and then goes to a person, never closed as "no
    // fee was taken" (the sender may be out the fee).
    if (rec === 'unknown') {
      if (!this.feeTransferDue(t)) return 'none';
      return old ? 'missing' : 'pending';
    }
    // A record in a status word we do not know (`outcome` null) says neither
    // that the fee was taken nor that it was not: asked again, like a pending
    // one, and never closed as "no fee was taken" (SWEEP-MONEY-4 C1).
    if (rec !== null && (rec.outcome === 'pending' || rec.outcome === null)) {
      // Past the day it is no longer asked: a person takes it, and it is NOT
      // closed as "no fee was taken" (the sender may be out the fee).
      return old ? 'review' : 'pending';
    }
    if (rec === null || rec.outcome !== 'completed') return 'none';
    const owed = rec.amountKobo + (rec.feeKobo ?? 0n);
    try {
      const platform = await this.provider.getPlatformAccount();
      // The fee that came in is in the ledger before the fee that goes back
      // (a write lost at the time is made now), and both leave WAWU's account
      // as the provider's does (FIX-66).
      await this.recordFeeLeg(t, platform.accountNumber, rec.amountKobo);
      // Until a fee-back has landed the sender's ledger shows the fee as
      // gone from the wallet, as the provider's balance does (FIX-70 round 2).
      await this.recordFeeOwed(t, rec);
      const moved = await this.moveFeeBack(
        t,
        platform.accountNumber,
        owed,
        now,
      );
      if (moved === 'rest') return 'rest';
      if (moved === 'wait') return 'pending';
    } catch (e) {
      this.logger.warn(
        `send ${t.id}: WAWU's fee could not be given back yet (${e instanceof WalletProviderError ? e.kind : 'error'}); asked again`,
      );
      return 'pending';
    }
    // FIX-54 round 2: what came back is what the provider's credit gave plus
    // this fee, so a reversed send's figures say both. The transfer above is
    // made once however often it is asked, and so is this note.
    if (t.payerWawuUserId) {
      try {
        await this.ledger.noteFeeReturned(
          {
            customerReference: t.customerReference,
            wawuUserId: t.payerWawuUserId,
          },
          owed,
        );
      } catch (e) {
        this.logger.error(
          `send ${t.id}: the fee given back could not be noted on the ledger (${e instanceof Error ? e.name : 'error'}); asked again`,
        );
        return 'pending';
      }
    }
    return 'done';
  }

  /**
   * A send that did not stand owes its sender the fee back. The row is
   * marked (`nextCheckAt` on a failed, reversed or completed send is
   * otherwise empty) so the sweep goes on until it is given back; the first
   * try is made now.
   */
  private async owe(t: TransferRow): Promise<void> {
    if (!this.feeLegDue(t)) return;
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id },
      data: { nextCheckAt: new Date() },
    });
    await this.returnOwed(t);
  }

  /** One try at giving a fee back; the mark stays while it is not done. */
  private async returnOwed(t: TransferRow, now = new Date()): Promise<void> {
    let result: 'done' | 'none' | 'pending' | 'rest' | 'review' | 'missing' =
      'pending';
    try {
      result = await this.returnFee(t, now);
    } catch (e) {
      this.logger.error(
        `send ${t.id}: giving the fee back failed (${e instanceof Error ? e.name : 'error'}); asked again`,
      );
    }
    if (result === 'rest') {
      await this.restFeeReturn(t, now);
      return;
    }
    if (result === 'review') {
      await this.holdFeeReturn(
        t,
        now,
        `WAWU's fee could not be given back: ${this.provider.label} has not said whether the fee transfer finished, a day after the fee became owed`,
      );
      return;
    }
    if (result === 'missing') {
      await this.holdFeeReturn(
        t,
        now,
        `WAWU's fee could not be given back: the fee transfer could not be found or read at ${this.provider.label}, a day after the fee became owed`,
      );
      return;
    }
    // A fee-back left pending or unreadable is asked about only until the
    // review bound; past it a person looks and the sweep lets it go (F3).
    if (result === 'pending' && this.feeOwedPastBound(t, now)) {
      await this.holdFeeReturn(
        t,
        now,
        `WAWU's fee could not be given back: ${this.provider.label} has not finished the transfer, or could not say, after ${this.settings.reviewAfterHours} hours`,
      );
      return;
    }
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id },
      data: {
        nextCheckAt:
          result === 'pending'
            ? new Date(Date.now() + FEE_RETURN_RETRY_MS)
            : null,
      },
    });
  }

  /**
   * A fee the provider failed to give back under both references (FIX-70):
   * nothing is sent. It is looked at again after a long rest and, past the
   * review bound (counted from when the fee became owed), taken out of the
   * sweep and put in front of a person, the money still owed to the sender.
   */
  private async restFeeReturn(t: TransferRow, now: Date): Promise<void> {
    if (!this.feeOwedPastBound(t, now)) {
      await this.prisma.walletTransfer.updateMany({
        where: { id: t.id },
        data: { nextCheckAt: new Date(now.getTime() + FEE_RETURN_REST_MS) },
      });
      return;
    }
    await this.holdFeeReturn(
      t,
      now,
      `WAWU's fee could not be given back: ${this.provider.label} failed the transfer twice, under two references`,
    );
  }

  /** When the fee became owed: the send failed or was reversed. */
  private feeOwedSince(t: TransferRow): number {
    return (t.failedAt ?? t.reversedAt ?? t.sentAt ?? t.createdAt).getTime();
  }

  /** The fee has been owed for the review bound or longer. */
  private feeOwedPastBound(t: TransferRow, now: Date): boolean {
    return (
      now.getTime() - this.feeOwedSince(t) >=
      this.settings.reviewAfterHours * 3_600_000
    );
  }

  /** The fee goes to a person (`reviewSince`, a note) and leaves the sweep, still owed to the sender. */
  private async holdFeeReturn(
    t: TransferRow,
    now: Date,
    note: string,
  ): Promise<void> {
    const flagged = await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, reviewSince: null },
      data: {
        reviewSince: now,
        discrepancy: (joinNotes(t.discrepancy, note) ?? note).slice(0, 1000),
      },
    });
    await this.prisma.walletTransfer.updateMany({
      where: { id: t.id },
      data: { nextCheckAt: null },
    });
    if (flagged.count > 0) {
      this.logger.error(
        `send ${t.id}: ${note}; held for a person, nothing is sent again`,
      );
    }
  }

  /** Sends that owe a fee back and are due another try. */
  private async returnOwedFees(now: Date): Promise<void> {
    const due = await this.prisma.walletTransfer.findMany({
      where: {
        status: { in: ['failed', 'reversed', 'completed'] },
        nextCheckAt: { lte: now },
        provider: this.provider.name,
      },
      orderBy: { nextCheckAt: 'asc' },
      take: SWEEP_PAGE,
    });
    for (const t of due) await this.returnOwed(t, now);
  }

  /**
   * A completed send that Nuvion reversed afterwards: its sender's row says
   * so, and the send follows it once (`completed` to `reversed`) and gives
   * the fee back with the rest when it had a fee leg (FIX-52). Every send of
   * the running provider follows, fee leg or not (FIX-54).
   */
  private async followLateReversal(t: TransferRow): Promise<TransferRow> {
    if (t.status !== 'completed' || t.provider !== this.provider.name) return t;
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: t.customerReference,
        direction: 'out',
        walletKind: 'user',
      },
      select: { status: true, reversedAt: true },
    });
    if (row?.status !== 'reversed') return t;
    const moved = await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'completed' },
      data: { status: 'reversed', reversedAt: row.reversedAt ?? new Date() },
    });
    const fresh = await this.reload(t);
    if (moved.count > 0) await this.owe(fresh);
    return fresh;
  }

  /**
   * The send's own transfer, made from the sweep or a wake: only for a send
   * that waited on its fee, once the fee is confirmed. The provider answers a
   * reference it has already seen with the original, so this never makes a
   * second transfer.
   */
  private async issueSend(
    t: TransferRow,
    now: Date,
  ): Promise<TransferStatus | null> {
    const wallet = t.payerAccountNumber
      ? await this.prisma.fintavaWallet.findUnique({
          where: { accountNumber: t.payerAccountNumber },
          select: { customerId: true, provider: true },
        })
      : null;
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      await this.reschedule(t, now);
      return 'pending';
    }
    let receipt: ProviderTransferReceipt;
    try {
      receipt =
        t.kind === 'bank_account'
          ? await this.provider.bankTransfer({
              from: { kind: 'customer', customerId: wallet.customerId },
              accountNumber: t.bankAccountNumber ?? '',
              accountName: t.bankAccountName ?? '',
              bankCode: t.bankCode ?? '',
              amountKobo: t.amountKobo,
              reference: t.customerReference,
              narration: TRANSFER_NARRATION,
              payee: null,
            })
          : await this.provider.walletToWallet({
              fromAccountNumber: t.payerAccountNumber!,
              toAccountNumber: t.recipientAccountNumber ?? '',
              amountKobo: t.amountKobo,
              reference: t.customerReference,
              narration: TRANSFER_NARRATION,
            });
    } catch (e) {
      if (
        e instanceof WalletProviderError &&
        !e.recordMayExist &&
        NO_TRANSFER_REFUSALS.includes(e.kind)
      ) {
        return (await this.markFailed(t, TRANSFER_FAILED_REASON))
          .status as TransferStatus;
      }
      await this.reschedule(t, now);
      return 'pending';
    }
    if (receipt.amountKobo !== t.amountKobo) {
      return (
        await this.toReview(
          t,
          `amountKobo ${t.amountKobo} vs ${receipt.amountKobo}`,
        )
      ).status as TransferStatus;
    }
    await this.markSentToBank(t, now);
    if (receipt.pending) {
      // Taken, not finished (FIX-54): as in `afterReceipt`, the send waits for
      // the provider's word and is asked again by the sweep.
      await this.reschedule(t, now);
      return (await this.reload(t)).status as TransferStatus;
    }
    return (
      await this.completeFromRecord(t, {
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
      })
    ).status as TransferStatus;
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
      await this.lookForLateSuccess(now);
      await this.returnOwedFees(now);
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
   * A bank send the provider refused before it took the money is failed at
   * once, on the word that no transfer exists (NO_TRANSFER_REFUSALS). When
   * that word is wrong the transfer completes anyway, and the app has told
   * the person it failed. A webhook that says so is caught by `settle`
   * (`noteLateSuccess`); this is the other way in, for a success the webhook
   * missed (FIX-41, SWEEP-MONEY F8): each bank send that failed in the last
   * 48 hours, at least an hour ago, with no provider record and not yet asked,
   * is asked about ONCE, by our reference. A read only, through the provider
   * seam (R-39): it sends nothing, and holds no row or connection while the
   * provider answers. A provider that could not be reached is asked again.
   */
  private async lookForLateSuccess(now: Date): Promise<void> {
    const due = await this.prisma.walletTransfer.findMany({
      where: {
        status: 'failed',
        kind: 'bank_account',
        provider: this.provider.name,
        checks: 0,
        reviewSince: null,
        sentToBankAt: null,
        failedAt: {
          gte: new Date(now.getTime() - FAILED_SEND_LOOK_UNTIL_MS),
          lte: new Date(now.getTime() - FAILED_SEND_LOOK_AFTER_MS),
        },
      },
      orderBy: { failedAt: 'asc' },
      take: SWEEP_PAGE,
      select: { id: true },
    });
    for (const { id } of due) {
      // Marked as asked first, under one short statement.
      const claimed = await this.prisma.walletTransfer.updateMany({
        where: { id, status: 'failed', checks: 0, reviewSince: null },
        data: { checks: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;
      const t = await this.prisma.walletTransfer.findUnique({ where: { id } });
      if (!t) continue;
      const answer = await this.askAboutFailed(t);
      if (answer === 'retry') {
        await this.prisma.walletTransfer.updateMany({
          where: { id, status: 'failed', checks: 1 },
          data: { checks: { decrement: 1 } },
        });
        continue;
      }
      if (
        answer?.state === 'found' &&
        answer.transaction.outcome === 'completed'
      ) {
        await this.recordSighting(
          t,
          'completed',
          answer.transaction,
          answer.source,
        );
        await this.flagLateSuccess(t, answer.source);
      }
    }
  }

  /**
   * What the provider knows of a failed send: a read by our reference.
   * `retry` when the provider could not be reached, null when it cannot be
   * asked at all (the sender's wallet is gone).
   */
  private async askAboutFailed(
    t: TransferRow,
  ): Promise<ProviderReconciliation | 'retry' | null> {
    const wallet = t.payerAccountNumber
      ? await this.prisma.fintavaWallet.findUnique({
          where: { accountNumber: t.payerAccountNumber },
          select: { customerId: true, provider: true },
        })
      : null;
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) return null;
    try {
      const answer = await this.provider.reconcileSend(
        t.customerReference,
        { kind: 'customer', customerId: wallet.customerId },
        t.sentAt ?? t.createdAt,
      );
      return answer.state === 'unknown' && answer.why === 'unreachable'
        ? 'retry'
        : answer;
    } catch (e) {
      this.logger.warn(
        `send ${t.id}: ${this.provider.label} could not be asked about a failed send (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
      return 'retry';
    }
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
      // failed, and the send follows it, once. A SUCCESS seen on it instead
      // is put in front of a person (FIX-41, SWEEP-MONEY F8).
      const followed = await this.followReversal(t);
      return (await this.noteLateSuccess(followed)).status as TransferStatus;
    }
    if (t.status === 'completed') {
      return (await this.followLateReversal(t)).status as TransferStatus;
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
      (row.failureReason === LEDGER_FINTAVA_FAILURE ||
        row.failureReason === LEDGER_BANK_SEND_FAILURE)
    ) {
      // The provider's own word (Fintava's, or Nuvion's `outflows.failed` for
      // a bank send it had taken: FIX-54).
      return (await this.markFailed(t, this.failureReasonOf(t), false))
        .status as TransferStatus;
    }
    // Pending, a disagreement held for review, or failed only because the
    // provider had no record of it yet: never proof that no money moved.
    // The provider is asked.
    if (!ask) return 'pending';
    const answer = await this.askProvider(t);
    if (
      this.feeLegDue(t) &&
      (answer?.state === 'absent' ||
        (answer?.state === 'unknown' && answer.why === 'unrecognised'))
    ) {
      // The provider holds no transfer of the send: it waits on its fee
      // (FIX-52). The fee's transfer is asked again (never repeated), and the
      // send goes out only once the fee is moved. A send the provider already
      // holds is never held up, and never has its fee taken late.
      const fee = await this.takeFee(t);
      if (fee.state === 'refused' && fee.definitive) {
        return (await this.markFailed(t, TRANSFER_FAILED_REASON))
          .status as TransferStatus;
      }
      if (fee.state === 'refused' || fee.state === 'pending') {
        await this.reschedule(t, now);
        return 'pending';
      }
      return this.issueSend(t, now);
    }
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
        // The provider holds a record of it, so the money moved and came back.
        return (await this.markFailed(t, this.failureReasonOf(t, true), false))
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
   * money is owed on either, so the charge is not compared. A COMPLETED
   * record of a send we failed (FIX-41) changes no status: the ledger keeps
   * the row failed and notes the disagreement, as it does for a webhook.
   */
  private async recordSighting(
    t: TransferRow,
    status: 'failed' | 'reversed' | 'completed',
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
          failureReason: status === 'failed' ? this.ledgerFailureOf(t) : null,
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

  /**
   * The reason a failed ledger row carries when the sweep's own reading
   * failed it: a Nuvion bank send says what the webhook path says
   * (`outflows.failed`), the provider-neutral bank text; any other send keeps
   * Fintava's, as before.
   */
  private ledgerFailureOf(t: TransferRow): string {
    return t.kind === 'bank_account' && t.provider === 'nuvion'
      ? LEDGER_BANK_SEND_FAILURE
      : LEDGER_FINTAVA_FAILURE;
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

  /**
   * What came back after a reversal, from the sender's row; null when the
   * provider gave no report. The row's total is the provider's credit plus
   * WAWU's fee once it was given back (LedgerService.noteFeeReturned), so
   * the figures equal what moved back to the wallet and the kept part is
   * only what no transfer returned.
   */
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
    const moved = await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'failed' },
      data: {
        status: 'reversed',
        reversedAt: row.reversedAt ?? new Date(),
      },
    });
    const fresh = await this.reload(t);
    // The fee it owed is looked at again as a reversed send's (FIX-85).
    if (moved.count > 0) await this.owe(fresh);
    return fresh;
  }

  /**
   * A failed bank send whose sender's ledger row says the transfer completed
   * (a webhook, or a provider read, saw a SUCCESS after the send was failed):
   * the send is put in front of a person (FIX-41, SWEEP-MONEY F8). Nothing
   * else moves, and the money is never sent again.
   */
  private async noteLateSuccess(t: TransferRow): Promise<TransferRow> {
    if (t.status !== 'failed' || t.reviewSince) return t;
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: t.customerReference,
        direction: 'out',
        walletKind: 'user',
      },
      select: { status: true, discrepancy: true },
    });
    const seen =
      row?.status === 'completed' ||
      (row?.status === 'failed' &&
        LATE_SUCCESS_SIGHTING.test(row.discrepancy ?? ''));
    return seen ? this.flagLateSuccess(t, 'webhook') : t;
  }

  /**
   * Sets the review flag and the discrepancy on a failed send that was seen
   * completed, and logs it once (the flag is set by one conditional write).
   * It changes no balance and never sends again.
   */
  private async flagLateSuccess(
    t: TransferRow,
    source: string,
  ): Promise<TransferRow> {
    const note = `${this.provider.label} shows this send completed after it was failed (${source})`;
    const flagged = await this.prisma.walletTransfer.updateMany({
      where: { id: t.id, status: 'failed', reviewSince: null },
      data: {
        reviewSince: new Date(),
        discrepancy: (joinNotes(t.discrepancy, note) ?? note).slice(0, 1000),
      },
    });
    if (flagged.count > 0) {
      this.logger.warn(
        `send ${t.id}: ${note}; it is held for review and nothing is sent again`,
      );
    }
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

  private async toReversed(t: TransferRow): Promise<TransferRow> {
    const row = await this.transition(t, 'reversed', {
      reversedAt: new Date(),
      nextCheckAt: null,
    });
    // Reversed before it completed: the fee goes back with the rest (FIX-52).
    if (row.status === 'reversed' && t.status === 'pending')
      await this.owe(row);
    return row;
  }

  /**
   * What the person reads on a send the provider failed. A bank send the
   * provider had taken (`sentToBankAt`) moved money that then came back, so it
   * says that; any other send moved nothing (FIX-54).
   */
  private failureReasonOf(t: TransferRow, providerHasIt = false): string {
    return t.kind === 'bank_account' &&
      (providerHasIt || t.sentToBankAt !== null)
      ? BANK_SEND_RETURNED_REASON
      : TRANSFER_FAILED_REASON;
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
    if (row.status === 'failed' && !t.reviewSince) await this.owe(row);
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
