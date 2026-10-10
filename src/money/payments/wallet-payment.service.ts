import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type ProviderReconciliation,
  type ProviderTransaction,
  type ProviderTransferReceipt,
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import { WalletBalanceService } from '../balance/wallet-balance.service';
import {
  PAYER_CHOSEN_AMOUNT_KINDS,
  type PaymentKind,
} from '../dto/money-enums';
import type {
  PaymentDto,
  PaymentQuoteQueryDto,
} from '../dto/money-request.dto';
import {
  QUOTE_CHANGED_MESSAGE,
  FeeQuoteService,
} from '../fees/fee-quote.service';
import type { OpenWallet } from '../gate/wallet-gate';
import type { LedgerMovementInput } from '../ledger/ledger.interface';
import {
  koboNumber,
  LEDGER_FINTAVA_FAILURE,
  LedgerService,
} from '../ledger/ledger.service';
import { MoneyError } from '../money-error';
import type {
  FeeQuoteView,
  PaymentQuoteView,
  PaymentStatus,
  PaymentView,
} from '../money-view.type';
import { type IdempotencyScope, IdempotencyService } from './idempotency';
import {
  MerchantWallet,
  PAYMENTS_UNAVAILABLE_MESSAGE,
} from './merchant-wallet';
import {
  type PayableKindHandler,
  PayableRegistry,
  type PayableTarget,
} from './payable-registry';
import { isUniqueViolationOn } from '../prisma-unique';
import { MoneyLimits } from '../limits/money-limits.service';
import { PaymentSettings, splitPrice } from './payment-config';
import { completedFigures, joinNotes } from './payment-figures';

/** The route a payment's Idempotency-Key is scoped to. */
export const PAY_ROUTE = 'POST money/payments';

export const NOT_PAYABLE_YET_MESSAGE =
  "This can't be paid for from your wallet yet.";
export const OWN_ITEM_MESSAGE = "You can't pay yourself for this.";
/** Only when the provider refused the transfer or said it failed: its word, not our inference. */
export const PAYMENT_FAILED_REASON =
  'The payment did not go through. No money left your wallet.';
/**
 * Beside every `pending` payment, and on `payment_in_progress` (lead ruling
 * D1, 4 Oct 2026): the outcome is not known yet, so nothing says no money
 * moved, and the buyer is told not to pay again.
 */
export const STILL_CONFIRMING_MESSAGE =
  "We're still confirming this payment. Don't pay again; we'll let you know.";
/**
 * On `payment_in_progress` when the open payment is already paid (the
 * provider moved the money) and what was paid for is still being delivered: the
 * item stays blocked until the delivery is recorded (lead ruling R2-1).
 */
export const FINISHING_MESSAGE =
  "Your payment went through and we're finishing it. Don't pay again.";
/** The provider refused for funds although a fresh balance read covers the total (lead ruling D3). */
export const BALANCE_CHANGED_MESSAGE =
  'Your balance changed. Check it and try again.';
/** What the provider sees on the transfer. Names nobody and nothing personal. */
export const PAYMENT_NARRATION = 'WAWU purchase';

/** Rows per page of the sweep, and pages per pass. */
const SWEEP_PAGE = 50;
const SWEEP_PAGES = 20;
const MINUTE = 60_000;

type PaymentRow = Prisma.WalletPaymentGetPayload<object>;

/** ₦1,323.25 from 132325, integer arithmetic only (no float, no locale). */
export function nairaText(kobo: number): string {
  const naira = Math.floor(kobo / 100);
  const rest = String(kobo % 100).padStart(2, '0');
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${grouped}.${rest}`;
}

/** The success envelope ResponseInterceptor sends, as the text a replay repeats. */
export function successBody(data: unknown): string {
  return JSON.stringify({ statusCode: 200, message: 'OK', data });
}

/** One open payment per buyer and item (lead ruling D1.2). */
export function openKeyOf(
  payer: string,
  kind: PaymentKind,
  targetId: string,
): string {
  return `${payer}:${kind}:${targetId}`;
}

/** The rest before the next check of a pending payment: 1, 2, 4 ... minutes, at most an hour. */
export function nextCheckDelayMs(checks: number): number {
  return Math.min(60, 2 ** Math.min(checks, 6)) * MINUTE;
}

/**
 * Provider refusals that mean no money moved and the person can fix it, or
 * the provider cannot take payments here at all: the key is given back.
 * `not_supported` is a provider whose adapter has no book transfer yet (the
 * Nuvion adapter before NUV-05): nothing was sent, so it is answered like a
 * provider that is not set up (503), never stored as a failed payment.
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
];

/**
 * The only currency a wallet payment takes today: naira, in kobo, from the
 * person's naira wallet (CLAUDE.md "Naira for Nigeria"). A feature that
 * prices an item in another currency (R-43: dollar prices for people billed
 * in dollars) is refused until a dollar wallet can pay it (NUV-09), so a
 * price in cents is never taken as kobo.
 */
export const PAYMENT_CURRENCY = 'NGN';
export const OTHER_CURRENCY_MESSAGE =
  "This isn't priced in naira, so it can't be paid from your naira wallet.";

/** A lost race on `WalletPayment.openKey`: another payment holds the item (R2-2: read through prisma-unique). */
export const isOpenKeyClash = (e: unknown) => isUniqueViolationOn(e, 'openKey');

/**
 * Pay from wallet (task MONEY-17): one way to take a payment from a
 * person's wallet for anything WAWU sells.
 *
 * - **Through the provider seam** (MONEY-20): every call to the company
 *   that holds the wallets goes through `WALLET_PROVIDER` (Fintava or
 *   Nuvion, picked at boot), never a provider's client; each payment
 *   records which provider took it (`provider`), and the sweep asks only
 *   the provider this server runs about its own payments (a rollback never
 *   asks one provider about the other's transfers).
 * - **Where the money goes.** One wallet-to-wallet transfer of the price
 *   (a book transfer at Nuvion) from the buyer's wallet to WAWU's own
 *   account at the provider (Fintava's merchant wallet, R-19; Nuvion's
 *   operational account, R-42), under our reference `wawu-pay-<payment id>`.
 *   The provider takes its charge on top (R-10), so the buyer pays the price
 *   plus the charge the fee quote showed (WALLET-15); WAWU adds no fee to a
 *   purchase. The quote is bound to the item (`payment:<kind>:<targetId>`).
 *   Naira only (`PAYMENT_CURRENCY`).
 * - **The split** is recorded with the payment, of the price only (R-10):
 *   the payee's 85% rounded down, WAWU's 15% the rest (R-5). Moving the 85%
 *   to the payee is WALLET-16's (R-11); the provider's charge on that move
 *   is WAWU's (R-31).
 * - **Once per key.** The Idempotency-Key is taken before the PIN; the
 *   payment, its pending ledger rows and the key's link to it are written in
 *   one transaction before the provider is called (idempotency.ts).
 * - **One open payment per buyer and item** (lead ruling D1.2, R2-1):
 *   `openKey` is unique from the claim until the payment is completely
 *   finished: `pending` (under review included), and, once paid, until what
 *   was paid for is delivered (the feature's record that the buyer owns it).
 *   A second request for the item, under any key, at any moment before that
 *   is `409 payment_in_progress` with the open payment's id. The claim is
 *   taken BEFORE the feature's "already owned" rule is read for the last
 *   time, and given back (nothing sent) when that says no.
 * - **Before money moves**, in order: the wallet (gate), the key, the PIN
 *   (guards), the body, the target and its price (the owning feature,
 *   PayableRegistry), the quote, the merchant cap, an open payment for the
 *   item, the provider's available balance (`402 insufficient_funds` with a
 *   real shortfall; never a sum of our own records).
 * - **An unknown outcome is `pending` until the provider says** (lead
 *   ruling D1): a timeout, a 5xx, a 2xx without a transaction, a repeated
 *   reference, a transfer the provider accepted and has not completed yet
 *   (`not_confirmed`), and the provider having no record of it yet. Absence
 *   is never proof that no money moved: the sweep keeps asking the provider
 *   (`reconcileSend`: lookup and the buyer's history, backing off to
 *   hourly), never sends again and never refunds; past
 *   PAYMENT_REVIEW_AFTER_HOURS it goes to manual review, still `pending`.
 *   Only the provider's own refusal or its failed record makes a payment
 *   `failed`. The seam's `walletToWallet` answers a receipt only for a
 *   transfer the provider has completed.
 * - **Settled at once.** A ledger row of the payment settled by anything
 *   (a webhook, MONEY-08's status check, a reversal) settles the payment in
 *   the same breath (`LedgerService.onPaymentSettled`); the sweep is the
 *   fallback.
 * - **The provider's figures are the record.** The ledger rows are written
 *   with the quoted figures before the send and the provider's after; any
 *   difference is kept on the row's `discrepancy` and on the payment, for
 *   MONEY-16 to report (a stop, not a fix).
 * - **Delivery is at least once:** a feature's `onCompleted` can run twice
 *   for one payment and must be idempotent.
 */
@Injectable()
export class WalletPaymentService implements OnModuleInit {
  private readonly logger = new Logger(WalletPaymentService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly balances: WalletBalanceService,
    private readonly merchant: MerchantWallet,
    private readonly registry: PayableRegistry,
    private readonly keys: IdempotencyService,
    private readonly settings: PaymentSettings,
    private readonly limits: MoneyLimits,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` by a request that died (a restart mid-send)
    // is answered from its payment once the send can no longer be running.
    this.keys.onStale(
      PAY_ROUTE,
      this.provider.timings.moneyTimeoutMs + MINUTE,
      async (row) => {
        const p = row.resourceId
          ? await this.prisma.walletPayment.findUnique({
              where: { id: row.resourceId },
            })
          : null;
        return p ? { status: 201, body: successBody(this.view(p)) } : null;
      },
    );
    // A payment's ledger row settled by anything settles the payment now.
    this.ledger.onPaymentSettled((e) => this.settle(e.paymentId));
  }

  // -------------------------------------------------------------------------
  // The quote (H14, W10, H17)
  // -------------------------------------------------------------------------

  /** What the pay sheet shows before the PIN. Nothing is reserved. */
  async quote(
    wallet: OpenWallet,
    q: PaymentQuoteQueryDto,
  ): Promise<PaymentQuoteView> {
    const { target } = await this.target(
      wallet.wawuUserId,
      q.kind,
      q.targetId,
      q.amountKobo,
    );
    const fee = this.fees.quote(
      wallet.wawuUserId,
      { kind: 'purchase', amountKobo: target.priceKobo },
      new Date(),
      subjectOf(q.kind, q.targetId),
    );
    return this.quoteView(
      q.kind,
      q.targetId,
      target,
      await this.withStanding(wallet.wawuUserId, fee, target.priceKobo),
      await this.balanceOrNull(wallet),
    );
  }

  /**
   * The quote with where today's purchase limit stands (NUV-07, G-410 (3)):
   * `withinDailyLimit` and `remainingTodayKobo` from WAWU's own limits, the
   * same figures `assertMayMove` holds the payment to inside its claim.
   */
  private async withStanding(
    payer: string,
    fee: FeeQuoteView,
    priceKobo: number,
  ): Promise<FeeQuoteView> {
    const standing = await this.limits.dailyStanding({
      wawuUserId: payer,
      kind: 'purchase',
      amountKobo: priceKobo,
    });
    return { ...fee, ...standing };
  }

  // -------------------------------------------------------------------------
  // Paying (H15 to H18)
  // -------------------------------------------------------------------------

  async pay(
    wallet: OpenWallet,
    dto: PaymentDto,
    scope: IdempotencyScope,
  ): Promise<PaymentView> {
    const payer = wallet.wawuUserId;
    if (
      dto.note !== undefined &&
      !PAYER_CHOSEN_AMOUNT_KINDS.includes(dto.kind)
    ) {
      throw new BadRequestException(['note is only sent with a tip.']);
    }
    const { handler, target } = await this.target(
      payer,
      dto.kind,
      dto.targetId,
      dto.amountKobo,
    );
    const price = target.priceKobo;

    const fee = await this.checkQuote(wallet, dto, target);

    const openKey = openKeyOf(payer, dto.kind, dto.targetId);
    await this.refuseIfOpen(openKey);

    // The provider's balance, never ours: a 503 or a 423 here moves nothing.
    const { availableKobo } = await this.balances.balance(wallet);
    if (availableKobo < fee.totalKobo) {
      throw this.insufficient(availableKobo, fee.totalKobo);
    }
    const merchant = await this.merchant.account();
    if (await this.isWawuAccount(wallet, merchant)) {
      this.logger.error('payment: the payer wallet is WAWU own account');
      throw new MoneyError(
        'provider_unreachable',
        PAYMENTS_UNAVAILABLE_MESSAGE,
        { retryAfterSeconds: this.provider.timings.retryAfterSeconds },
      );
    }

    const id = randomUUID();
    const split = splitPrice(price, target.payee !== null);
    const now = new Date();
    const data: Prisma.WalletPaymentCreateInput = {
      id,
      payerWawuUserId: payer,
      kind: dto.kind,
      targetId: dto.targetId,
      title: target.title.slice(0, 200),
      payeeWawuUserId: target.payee?.wawuUserId ?? null,
      priceKobo: BigInt(price),
      providerFeeKobo: BigInt(fee.fee.providerFeeKobo),
      wawuFeeKobo: BigInt(fee.fee.wawuFeeKobo),
      totalKobo: BigInt(fee.totalKobo),
      payeeShareKobo: BigInt(split.payeeShareKobo),
      wawuShareKobo: BigInt(split.wawuShareKobo),
      customerReference: `wawu-pay-${id}`,
      payerAccountNumber: wallet.accountNumber,
      merchantAccountNumber: merchant,
      provider: this.provider.name,
      status: 'pending',
      openKey,
      nextCheckAt: new Date(now.getTime() + MINUTE),
      note: dto.note?.trim() ? dto.note.trim() : null,
      sentAt: now,
    };

    // The CLAIM: the payment, its pending ledger rows and the key's link to
    // it, in one transaction, before the provider is called (a crash after the
    // send still leaves a payment the sweep settles, and a repeat of the key
    // is answered from this payment). Its unique `openKey` is what makes one
    // buyer and one item one open payment, under any key.
    const payment = await this.claim(scope, id, data, openKey);

    // The claim is held, and the claim is never given up before what was paid
    // for is delivered (complete / fulfil below), so anything the feature
    // records on delivery (that the buyer now owns the item) is visible to
    // this read, and nothing can be delivered to this buyer for this item
    // until this payment is done. The feature's own rules are asked again
    // NOW, inside the claim: the first read above ran before the claim and
    // can be stale (lead ruling R2-1). Still payable, same price and payee,
    // or the claim is given back and nothing is sent.
    try {
      const again = await this.target(
        payer,
        dto.kind,
        dto.targetId,
        dto.amountKobo,
      );
      if (
        again.target.priceKobo !== price ||
        (again.target.payee?.wawuUserId ?? null) !==
          (target.payee?.wawuUserId ?? null)
      ) {
        throw await this.quoteChanged(wallet, dto, again.target);
      }
      await this.checkQuote(wallet, dto, again.target);
    } catch (e) {
      await this.abandon(payment, scope);
      throw e;
    }

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: wallet.accountNumber,
        toAccountNumber: payment.merchantAccountNumber,
        amountKobo: BigInt(price),
        reference: payment.customerReference,
        narration: PAYMENT_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(payment, scope, e, wallet);
    }
    return this.afterReceipt(payment, scope, receipt, handler);
  }

  /**
   * Writes the payment that takes the buyer's open slot for this item. Another
   * payment holding it (found first, or lost to at the unique key) is `409
   * payment_in_progress` with that payment's id; a holder that finished in
   * between is simply asked about again.
   */
  private async claim(
    scope: IdempotencyScope,
    id: string,
    data: Prisma.WalletPaymentCreateInput,
    openKey: string,
  ): Promise<PaymentRow> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // READ COMMITTED (Postgres's default; nothing here raises it): WAWU's
        // limits take a per-person lock for this transaction and count the
        // person's purchases today and this month, so two payments by one
        // person are checked one after the other and the second sees the
        // first one's pending ledger row (NUV-07, G-410 (2)).
        return await this.prisma.$transaction(async (tx) => {
          await this.limits.assertMayMove(
            {
              wawuUserId: data.payerWawuUserId!,
              kind: 'purchase',
              amountKobo: koboNumber(BigInt(data.priceKobo)),
            },
            { tx },
          );
          await this.keys.attach(tx, scope, id);
          const row = await tx.walletPayment.create({ data });
          await this.ledger.record(this.movement(row, 'out', 'pending'), tx);
          await this.ledger.record(this.movement(row, 'in', 'pending'), tx);
          return row;
        });
      } catch (e) {
        // Another payment for this item got there first (taps at once under
        // different keys): it is the open one.
        if (!isOpenKeyClash(e)) throw e;
        await this.refuseIfOpen(openKey);
      }
    }
    throw new MoneyError('payment_in_progress', STILL_CONFIRMING_MESSAGE);
  }

  /** `409 payment_in_progress` when this buyer has an open payment for this item. */
  private async refuseIfOpen(openKey: string): Promise<void> {
    const open = await this.prisma.walletPayment.findUnique({
      where: { openKey },
      select: { id: true, status: true },
    });
    if (open) {
      throw new MoneyError(
        'payment_in_progress',
        open.status === 'completed'
          ? FINISHING_MESSAGE
          : STILL_CONFIRMING_MESSAGE,
        { paymentId: open.id },
      );
    }
  }

  /**
   * The payment was claimed but must not be sent (the second read of the item
   * says it is no longer payable): nothing moved. The claim and the key are
   * given back.
   */
  private async abandon(
    payment: PaymentRow,
    scope: IdempotencyScope,
  ): Promise<void> {
    try {
      await this.markFailed(payment, PAYMENT_FAILED_REASON);
      await this.keys.release(scope);
    } catch (e) {
      this.logger.error(
        `payment ${payment.id}: the claim of an unsent payment was not given back (${e instanceof Error ? e.name : 'error'}); the sweep settles it`,
      );
    }
  }

  /** The quote the buyer saw, checked against the item as it stands now (G-64). */
  private async checkQuote(
    wallet: OpenWallet,
    dto: PaymentDto,
    target: PayableTarget,
  ): Promise<FeeQuoteView> {
    const payer = wallet.wawuUserId;
    try {
      return this.fees.check(
        payer,
        { kind: 'purchase', amountKobo: target.priceKobo },
        dto.expectedTotalKobo,
        dto.quoteToken,
        new Date(),
        subjectOf(dto.kind, dto.targetId),
      );
    } catch (e) {
      if (e instanceof MoneyError && e.code === 'quote_changed') {
        throw await this.quoteChanged(wallet, dto, target);
      }
      throw e;
    }
  }

  /** `409 quote_changed` with the payment quote as it stands. */
  private async quoteChanged(
    wallet: OpenWallet,
    dto: PaymentDto,
    target: PayableTarget,
  ): Promise<MoneyError> {
    const fresh = this.fees.quote(
      wallet.wawuUserId,
      { kind: 'purchase', amountKobo: target.priceKobo },
      new Date(),
      subjectOf(dto.kind, dto.targetId),
    );
    return new MoneyError('quote_changed', QUOTE_CHANGED_MESSAGE, {
      paymentQuote: this.quoteView(
        dto.kind,
        dto.targetId,
        target,
        await this.withStanding(wallet.wawuUserId, fresh, target.priceKobo),
        await this.balanceOrNull(wallet),
      ),
    });
  }

  /**
   * Whether the payer's wallet is WAWU's own account at the provider (lead
   * ruling R5-1): the same account, however the provider names it. Fintava
   * names each account by one number; Nuvion knows one account by its NGN
   * account number, its id and its `nuvion_ban`, so the provider is asked
   * (`isSameAccount`). When it cannot say, nothing is sent (503).
   */
  private async isWawuAccount(
    wallet: OpenWallet,
    merchant: string,
  ): Promise<boolean> {
    if (merchant === wallet.accountNumber || merchant === wallet.walletId) {
      return true;
    }
    if (!this.provider.isSameAccount) return false;
    try {
      return await this.provider.isSameAccount(wallet.accountNumber, merchant);
    } catch (e) {
      if (e instanceof WalletProviderError) throw e.toHttpException();
      throw e;
    }
  }

  /** The provider did not take the payment, or we do not know whether it did. */
  private async afterRefusal(
    payment: PaymentRow,
    scope: IdempotencyScope,
    e: unknown,
    wallet: OpenWallet,
  ): Promise<PaymentView> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (!refusal || refusal.recordMayExist) {
      // Money may have moved (a lost answer, or a transfer the provider
      // accepted and has not completed). Pending until the provider says;
      // nothing is sent again from here.
      this.logger.warn(
        `payment ${payment.id}: outcome unknown (${refusal?.kind ?? 'error'}); pending until ${this.provider.label} says`,
      );
      return this.answer(scope, payment);
    }
    const failed = await this.markFailed(payment, PAYMENT_FAILED_REASON);
    if (
      RELEASED.includes(refusal.kind) ||
      refusal instanceof WalletProviderLimitError
    ) {
      // Nothing moved and the person can fix the cause: the key is given
      // back so the same payment can be sent again (CONVENTIONS section 4).
      await this.keys.release(scope);
      if (refusal.kind === 'insufficient_funds') {
        throw this.providerSaidInsufficient(
          await this.balanceOrNull(wallet),
          koboNumber(payment.totalKobo),
        );
      }
      // The provider's own answer (G-410 (4)): its limit is the same `403
      // limit_reached` as WAWU's (NUV-07), a frozen wallet `423
      // wallet_frozen`, anything else `503 provider_unreachable` with the
      // provider's wait.
      throw refusal.toHttpException();
    }
    this.logger.warn(
      `payment ${payment.id}: ${this.provider.label} refused it (${refusal.kind}); nothing moved`,
    );
    return this.answer(scope, failed);
  }

  /**
   * The provider completed the transfer and said what it took. Its figures
   * are compared as the integers they are (bigint kobo): the price moved and
   * the payment completes at what the provider took (`completeFromRecord`),
   * or the payment is stopped for review.
   */
  private async afterReceipt(
    payment: PaymentRow,
    scope: IdempotencyScope,
    receipt: ProviderTransferReceipt,
    handler: PayableKindHandler,
  ): Promise<PaymentView> {
    const refs = {
      fintavaReference: receipt.providerReference,
      tagapayTransRef: receipt.secondaryReference,
      fintavaTransactionId: receipt.transactionId,
    };
    if (receipt.amountKobo !== payment.priceKobo) {
      // The provider moved another amount than the price: a stop. The ledger
      // keeps both figures (a disagreement), and the payment goes to review
      // (still pending, nothing delivered).
      const notes: string[] = [];
      for (const side of ['out', 'in'] as const) {
        try {
          const r = await this.ledger.record(
            this.movement(
              payment,
              side,
              'completed',
              {
                amountKobo: safeKoboNumber(receipt.amountKobo),
                feeKobo: side === 'out' ? safeKoboNumber(receipt.feeKobo) : 0,
                totalKobo: safeKoboNumber(
                  side === 'out' ? receipt.totalKobo : receipt.amountKobo,
                ),
              },
              refs,
            ),
            undefined,
            { quiet: true },
          );
          if (r.discrepancy) notes.push(r.discrepancy);
        } catch (e) {
          this.logger.error(
            `payment ${payment.id}: the ledger could not record the receipt (${e instanceof Error ? e.name : 'error'})`,
          );
        }
      }
      this.logger.error(
        `payment ${payment.id}: ${this.provider.label} moved another amount than the price; sent to review`,
      );
      const row = await this.toReview(
        payment,
        joinNotes(...notes) ??
          `amountKobo ${payment.priceKobo} vs ${receipt.amountKobo}`,
      );
      return this.answer(scope, row);
    }
    const row = await this.completeFromRecord(
      payment,
      {
        amountKobo: receipt.amountKobo,
        feeKobo: receipt.feeKobo,
        totalKobo: receipt.totalKobo,
        refs,
        source: 'send',
        occurredAt: null,
        debitRecorded: false,
      },
      handler,
    );
    return this.answer(scope, row);
  }

  /**
   * THE one place a payment is completed (lead ruling R6-1, 10 Oct 2026):
   * from the provider's answer to the send, from the payment sweep's lookup,
   * and from a ledger row some other job settled (the status check, a
   * webhook). The provider's own record decides the figures
   * (`completedFigures`), never the quote:
   * - **as quoted**: both ledger rows complete, the payment completes.
   * - **below the quote**: the buyer's row takes the real charge and
   *   completes (nobody is owed anything, and a delivered purchase is never
   *   left `pending`), the merchant's completes, the payment records the real
   *   figures and the difference on `discrepancy`; no flag.
   * - **above the quote**: the payment records and answers the real total and
   *   is flagged for review (`debitReviewSince`, both figures on
   *   `discrepancy`); the price moved as asked, so it is delivered. The
   *   buyer's row keeps the ledger's rule (a disagreement is held `pending`
   *   with its note, NUV-08 reconciles); the merchant's completes.
   * The merchant-side (`in`) row is completed on every path, so a completed
   * payment never leaves WAWU's side of the ledger `pending` (R6-2).
   */
  private async completeFromRecord(
    p: PaymentRow,
    rec: {
      amountKobo: bigint;
      feeKobo: bigint | null;
      totalKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      source: 'send' | 'lookup' | 'history';
      occurredAt: Date | null;
      /** The buyer's row is already the record (it is what settled the payment). */
      debitRecorded: boolean;
    },
    handler?: PayableKindHandler,
  ): Promise<PaymentRow> {
    const figures = completedFigures(
      { providerFeeKobo: p.providerFeeKobo, totalKobo: p.totalKobo },
      rec,
      this.provider.label,
    );
    const price = koboNumber(p.priceKobo);
    const notes: string[] = [];
    const sighted = <T extends LedgerMovementInput>(m: T): T => ({
      ...m,
      source: rec.source,
      ...(rec.occurredAt ? { occurredAt: rec.occurredAt } : {}),
    });
    if (!rec.debitRecorded) {
      try {
        if (figures.verdict === 'below') {
          // The buyer's row was written with the quoted charge; the real one
          // is lower, so the row takes it and completes (never held).
          await this.ledger.completeDebitAt(
            p.id,
            { feeKobo: p.providerFeeKobo, totalKobo: p.totalKobo },
            { feeKobo: figures.feeKobo, totalKobo: figures.totalKobo },
            rec.source,
          );
        }
        const out = await this.ledger.record(
          sighted(
            this.movement(
              p,
              'out',
              'completed',
              {
                amountKobo: price,
                feeKobo: koboNumber(figures.feeKobo),
                totalKobo: koboNumber(figures.totalKobo),
              },
              rec.refs,
            ),
          ),
          undefined,
          { quiet: true },
        );
        if (out.discrepancy) notes.push(out.discrepancy);
      } catch (e) {
        // The money moved; the webhook and the status check will write the
        // ledger. The payment's own status is the provider's record.
        this.logger.error(
          `payment ${p.id}: the ledger could not record the debit (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    try {
      const inn = await this.ledger.record(
        sighted(
          this.movement(
            p,
            'in',
            'completed',
            { amountKobo: price, feeKobo: 0, totalKobo: price },
            rec.refs,
          ),
        ),
        undefined,
        { quiet: true },
      );
      if (inn.discrepancy) notes.push(inn.discrepancy);
    } catch (e) {
      this.logger.error(
        `payment ${p.id}: the ledger could not record the credit (${e instanceof Error ? e.name : 'error'})`,
      );
    }
    // As it stands now: the settle that got here may have copied the ledger
    // row's note onto it since `p` was read.
    let payment = await this.prisma.walletPayment.findUniqueOrThrow({
      where: { id: p.id },
    });
    if (figures.verdict !== 'as_quoted') {
      const above = figures.verdict === 'above';
      if (above) {
        this.logger.error(
          `payment ${p.id}: ${figures.note}; flagged for review`,
        );
      }
      await this.prisma.walletPayment.updateMany({
        where: { id: p.id, status: 'pending' },
        data: {
          providerFeeKobo: figures.feeKobo,
          totalKobo: figures.totalKobo,
          ...(above
            ? { debitReviewSince: payment.debitReviewSince ?? new Date() }
            : {}),
        },
      });
      payment = await this.prisma.walletPayment.findUniqueOrThrow({
        where: { id: p.id },
      });
    }
    return this.complete(
      payment,
      joinNotes(payment.discrepancy, figures.note, ...notes),
      handler,
    );
  }

  // -------------------------------------------------------------------------
  // Settling payments whose answer was lost, and delivering what was paid for
  // -------------------------------------------------------------------------

  /**
   * Every minute: every pending payment due a check (not under review), in
   * the order of its next check, paged by key so none waits behind another;
   * then every completed payment not yet delivered whose next attempt is due
   * (same backoff as the check, review past the bound; a paid kind nothing
   * registers goes to review at once). A payment still unknown
   * after a check is asked again later (1, 2, 4 ... minutes, at most an
   * hour), and goes to review past PAYMENT_REVIEW_AFTER_HOURS.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-payment-settle' })
  async sweep(
    now = new Date(),
  ): Promise<{ checked: number; settled: number; delivered: number }> {
    const counts = { checked: 0, settled: 0, delivered: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      let after: { at: Date; id: string } | null = null;
      for (let page = 0; page < SWEEP_PAGES; page += 1) {
        const where: Prisma.WalletPaymentWhereInput = {
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
        const due = await this.prisma.walletPayment.findMany({
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

      await this.completeMerchantRows();

      const delivering = this.registry
        .kinds()
        .filter((k) => typeof this.registry.get(k)?.onCompleted === 'function');
      // A paid payment whose kind nothing here registers (a feature that was
      // taken out, a boot without its module): nobody can deliver it, and it
      // is never skipped in silence. It goes to review at once, logged.
      await this.reviewUnregistered(now);
      const reviewAfterMs = this.settings.reviewAfterHours * 3_600_000;
      let cursor: string | null = null;
      for (let page = 0; delivering.length && page < SWEEP_PAGES; page += 1) {
        const owed: PaymentRow[] = await this.prisma.walletPayment.findMany({
          where: {
            status: 'completed',
            fulfilledAt: null,
            reviewSince: null,
            payerWawuUserId: { not: null },
            kind: { in: delivering },
            // The delivery the completion itself started has had a minute,
            // then each failed one pushes the next out (1, 2, 4 ... 60
            // minutes, as the check does): only one that is due is tried.
            OR: [
              { nextDeliveryAt: { lte: now } },
              {
                nextDeliveryAt: null,
                completedAt: { lt: new Date(now.getTime() - MINUTE) },
              },
            ],
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: SWEEP_PAGE,
        });
        for (const p of owed) {
          const since = (p.completedAt ?? p.sentAt ?? p.createdAt).getTime();
          if (now.getTime() - since >= reviewAfterMs) {
            await this.toDeliveryReview(
              p,
              `not delivered ${this.settings.reviewAfterHours} hours after the payment completed (${p.deliveryAttempts} attempts)`,
            );
            continue;
          }
          const handler = this.registry.get(p.kind as PaymentKind);
          if (handler && (await this.fulfil(p, handler, now))) {
            counts.delivered += 1;
          }
        }
        if (owed.length < SWEEP_PAGE) break;
        cursor = owed[owed.length - 1].id;
      }
    } catch (e) {
      this.logger.error(
        `payment sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /**
   * WAWU's side of a completed payment (the `in` row on the merchant wallet)
   * is never left `pending` (R6-2). Every path that completes a payment
   * completes it with the payment; this is the net under them for a ledger
   * write that failed once (a lost connection, a deadlock the ledger gave up
   * on): the payment is complete, so its merchant row is completed from it.
   * At most one page per pass, oldest first, the running provider's only.
   */
  private async completeMerchantRows(): Promise<void> {
    const stuck = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p."id" AS "id"
        FROM "FintavaLedgerEntry" e
        JOIN "WalletPayment" p ON p."id" = e."paymentId"
       WHERE e."status" = 'pending' AND e."direction" = 'in'
         AND e."walletKind" = 'merchant'
         AND p."status" = 'completed' AND p."provider" = ${this.provider.name}
       ORDER BY e."occurredAt", p."id"
       LIMIT ${SWEEP_PAGE}`;
    for (const { id } of stuck) {
      const p = await this.prisma.walletPayment.findUnique({ where: { id } });
      if (!p) continue;
      const out = await this.prisma.fintavaLedgerEntry.findFirst({
        where: {
          customerReference: p.customerReference,
          direction: 'out',
          walletKind: 'user',
        },
        select: {
          fintavaReference: true,
          tagapayTransRef: true,
          fintavaTransactionId: true,
        },
      });
      const price = koboNumber(p.priceKobo);
      try {
        await this.ledger.record(
          {
            ...this.movement(
              p,
              'in',
              'completed',
              { amountKobo: price, feeKobo: 0, totalKobo: price },
              out ?? {},
            ),
            source: 'lookup',
          },
          undefined,
          { quiet: true },
        );
      } catch (e) {
        this.logger.error(
          `payment ${p.id}: its merchant ledger row could not be completed (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
  }

  /**
   * Settles one pending payment from what is known: its buyer-side ledger
   * row when that is settled, else the provider itself (`reconcileSend`: by
   * our reference, then the buyer's history). `ask`: whether to ask the
   * provider (the sweep) or only read the ledger (the ledger listener). A
   * payment another provider took (written before a switch of
   * WALLET_PROVIDER) is never asked of this one: this provider's silence
   * about it says nothing. It waits on its ledger rows and goes to review
   * past the bound, as any payment nothing answers for.
   */
  async settle(
    paymentId: string,
    now = new Date(),
    ask = false,
  ): Promise<PaymentStatus | null> {
    const p = await this.prisma.walletPayment.findUnique({
      where: { id: paymentId },
    });
    if (!p) return null;
    if (p.status !== 'pending') return p.status as PaymentStatus;
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: p.customerReference,
        direction: 'out',
        walletKind: 'user',
      },
    });
    if (row?.discrepancy && row.discrepancy !== p.discrepancy) {
      await this.prisma.walletPayment.update({
        where: { id: p.id },
        data: { discrepancy: row.discrepancy.slice(0, 1000) },
      });
    }
    if (row?.status === 'completed') {
      // Some other job settled the buyer's row (the status check, a webhook):
      // that row is the provider's record, and the payment completes from it
      // the same way every other path does, merchant side included (R6-2).
      return (
        await this.completeFromRecord(p, {
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
      ).status as PaymentStatus;
    }
    if (row?.status === 'reversed') {
      return (await this.transition(p, 'reversed', { openKey: null }))
        .status as PaymentStatus;
    }
    if (
      row?.status === 'failed' &&
      row.failureReason === LEDGER_FINTAVA_FAILURE
    ) {
      return (await this.markFailed(p, PAYMENT_FAILED_REASON, false))
        .status as PaymentStatus;
    }
    // Pending, a disagreement held for review, or failed only because the
    // provider had no record of it yet: never proof that no money moved.
    // The provider is asked.
    if (!ask) return 'pending';
    const answer = await this.askProvider(p);
    if (answer?.state === 'found') {
      const t = answer.transaction;
      const status = t.outcome;
      if (status === 'completed' && t.amountKobo === p.priceKobo) {
        // The provider's record decides the figures: its charge when the
        // record carries one (Nuvion's `applicable_fee`), else the quote.
        return (
          await this.completeFromRecord(p, {
            amountKobo: t.amountKobo,
            feeKobo: t.feeKobo ?? null,
            totalKobo: null,
            refs: {
              fintavaReference: t.providerReference,
              tagapayTransRef: t.secondaryReference,
              fintavaTransactionId: t.id,
            },
            source: answer.source,
            occurredAt: Number.isNaN(Date.parse(t.createdAt))
              ? null
              : new Date(t.createdAt),
            debitRecorded: false,
          })
        ).status as PaymentStatus;
      }
      if (status === 'completed') {
        return (
          await this.toReview(
            p,
            `${this.provider.label} moved ${t.amountKobo} kobo for a price of ${p.priceKobo}`,
          )
        ).status as PaymentStatus;
      }
      if (status === 'failed') {
        await this.recordSighting(p, row, 'failed', t, answer.source);
        return (await this.markFailed(p, PAYMENT_FAILED_REASON, false))
          .status as PaymentStatus;
      }
      if (status === 'reversed') {
        return this.settleReversed(p, row, t, answer.source);
      }
      // Any other word (null: a status we do not know) says neither: still
      // pending, asked again later, and to review past the bound. Never read
      // as "no money moved".
    }
    await this.reschedule(p, now);
    return 'pending';
  }

  /**
   * The provider moved the payment and then reversed it (lead ruling 7, 8
   * Oct 2026): the debit came back to the buyer at the provider, so nothing
   * is owed back by WAWU and nothing is delivered. The payment is
   * `reversed`, both ledger sides say so, and the item is free again. A
   * reversal of another amount than the price is a stop: review, the item
   * still claimed.
   */
  private async settleReversed(
    p: PaymentRow,
    out: { feeKobo: bigint; totalKobo: bigint } | null,
    t: ProviderTransaction,
    source: 'lookup' | 'history',
  ): Promise<PaymentStatus> {
    if (t.amountKobo !== p.priceKobo) {
      return (
        await this.toReview(
          p,
          `${this.provider.label} reversed ${t.amountKobo} kobo for a price of ${p.priceKobo}`,
        )
      ).status as PaymentStatus;
    }
    await this.recordSighting(p, out, 'reversed', t, source);
    this.logger.warn(
      `payment ${p.id}: ${this.provider.label} reversed the transfer; the money went back to the buyer and nothing is delivered`,
    );
    return (
      await this.transition(p, 'reversed', { openKey: null, nextCheckAt: null })
    ).status as PaymentStatus;
  }

  /**
   * What the provider knows of the payment's transfer, or null when it
   * cannot be asked: the payment is another provider's, the payer's wallet
   * is gone, or the provider did not answer.
   */
  private async askProvider(
    p: PaymentRow,
  ): Promise<ProviderReconciliation | null> {
    if (p.provider !== this.provider.name) return null;
    const wallet = p.payerAccountNumber
      ? await this.prisma.fintavaWallet.findUnique({
          where: { accountNumber: p.payerAccountNumber },
          select: { customerId: true },
        })
      : null;
    if (!wallet) return null;
    try {
      return await this.provider.reconcileSend(
        p.customerReference,
        { kind: 'customer', customerId: wallet.customerId },
        p.sentAt ?? p.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `payment ${p.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
      return null;
    }
  }

  /**
   * The provider's record of a transfer that FAILED or was REVERSED onto both
   * ledger sides (a revival when the row was failed as absent), with the
   * row's own fee: no money is owed on either, so the charge is not compared.
   * A completed transfer goes through `completeFromRecord`, which decides the
   * figures from the record.
   */
  private async recordSighting(
    p: PaymentRow,
    out: { feeKobo: bigint; totalKobo: bigint } | null,
    status: 'failed' | 'reversed',
    t: ProviderTransaction,
    source: 'lookup' | 'history',
  ): Promise<void> {
    if (!p.payerAccountNumber) return;
    const refs = {
      fintavaReference: t.providerReference,
      tagapayTransRef: t.secondaryReference,
      fintavaTransactionId: t.id,
    };
    const occurredAt = Number.isNaN(Date.parse(t.createdAt))
      ? null
      : new Date(t.createdAt);
    try {
      const fee = out ? koboNumber(out.feeKobo) : koboNumber(p.providerFeeKobo);
      const total = out ? koboNumber(out.totalKobo) : koboNumber(p.totalKobo);
      const amount = safeKoboNumber(t.amountKobo);
      await this.ledger.record(
        {
          ...this.movement(
            p,
            'out',
            status,
            {
              amountKobo: amount,
              feeKobo: fee,
              totalKobo: total,
            },
            refs,
          ),
          source,
          occurredAt,
          failureReason: status === 'failed' ? LEDGER_FINTAVA_FAILURE : null,
        },
        undefined,
        { quiet: true },
      );
      await this.ledger.record(
        {
          ...this.movement(
            p,
            'in',
            status,
            {
              amountKobo: amount,
              feeKobo: 0,
              totalKobo: amount,
            },
            refs,
          ),
          source,
          occurredAt,
          failureReason: status === 'failed' ? LEDGER_FINTAVA_FAILURE : null,
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `payment ${p.id}: the ledger could not record ${this.provider.label}'s record (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** Still unknown: asked again later, or sent to review past the bound. */
  private async reschedule(p: PaymentRow, now: Date): Promise<void> {
    const sent = (p.sentAt ?? p.createdAt).getTime();
    if (now.getTime() - sent >= this.settings.reviewAfterHours * 3_600_000) {
      await this.toReview(
        p,
        p.provider === this.provider.name
          ? `no answer from ${this.provider.label} after ${this.settings.reviewAfterHours} hours`
          : `taken by ${p.provider}, which this server does not run (WALLET_PROVIDER=${this.provider.name}); no answer after ${this.settings.reviewAfterHours} hours`,
      );
      return;
    }
    await this.prisma.walletPayment.updateMany({
      where: { id: p.id, status: 'pending' },
      data: {
        checks: { increment: 1 },
        nextCheckAt: new Date(now.getTime() + nextCheckDelayMs(p.checks + 1)),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  /** The owning feature's record of the target, after the kind's own rules. */
  private async target(
    payer: string,
    kind: PaymentKind,
    targetId: string,
    amountKobo: number | undefined,
  ): Promise<{ handler: PayableKindHandler; target: PayableTarget }> {
    const payerChosen = PAYER_CHOSEN_AMOUNT_KINDS.includes(kind);
    if (payerChosen && amountKobo === undefined) {
      throw new BadRequestException(['amountKobo is required for a tip.']);
    }
    if (!payerChosen && amountKobo !== undefined) {
      throw new BadRequestException(['amountKobo is only sent with a tip.']);
    }
    const handler = this.registry.get(kind);
    if (!handler) {
      throw new MoneyError('target_not_payable', NOT_PAYABLE_YET_MESSAGE);
    }
    const target = await handler.resolve({
      payerWawuUserId: payer,
      targetId,
      amountKobo,
    });
    if (
      !Number.isSafeInteger(target.priceKobo) ||
      target.priceKobo < 1 ||
      (payerChosen && target.priceKobo !== amountKobo)
    ) {
      // A feature's mistake, never the buyer's: nothing is charged on it.
      throw new Error(
        `PayableRegistry: ${kind} answered a price that is not the item's.`,
      );
    }
    if ((target.currency ?? PAYMENT_CURRENCY) !== PAYMENT_CURRENCY) {
      // A price in another currency is never taken as kobo from the naira
      // wallet (R-43: dollar prices are for people billed in dollars).
      throw new MoneyError('target_not_payable', OTHER_CURRENCY_MESSAGE);
    }
    if (target.payee?.wawuUserId === payer) {
      throw new MoneyError('target_not_payable', OWN_ITEM_MESSAGE);
    }
    return { handler, target };
  }

  private quoteView(
    kind: PaymentKind,
    targetId: string,
    target: PayableTarget,
    fee: FeeQuoteView,
    balanceKobo: number | null,
  ): PaymentQuoteView {
    return {
      kind,
      targetId,
      title: target.title,
      payee: target.payee,
      priceKobo: target.priceKobo,
      fee: fee.fee,
      totalKobo: fee.totalKobo,
      balanceKobo,
      shortfallKobo:
        balanceKobo === null ? null : Math.max(0, fee.totalKobo - balanceKobo),
      willBeHeld: false,
      withinDailyLimit: fee.withinDailyLimit,
      remainingTodayKobo: fee.remainingTodayKobo,
      quoteToken: fee.quoteToken,
      expiresAt: fee.expiresAt,
    };
  }

  /** Our own balance read was short: the shortfall is always 1 kobo or more. */
  private insufficient(balanceKobo: number, totalKobo: number): MoneyError {
    const shortfallKobo = totalKobo - balanceKobo;
    return new MoneyError(
      'insufficient_funds',
      `You need ${nairaText(shortfallKobo)} more in your wallet.`,
      { balanceKobo, totalKobo, shortfallKobo },
    );
  }

  /**
   * The provider refused for funds after our read said there was enough
   * (lead ruling D3): a real shortfall on a fresh read is shown; otherwise
   * the balance moved or the provider took more than quoted, and nothing below 1 kobo
   * is ever shown as a shortfall.
   */
  private providerSaidInsufficient(
    balanceKobo: number | null,
    totalKobo: number,
  ): MoneyError {
    if (balanceKobo !== null && balanceKobo < totalKobo) {
      return this.insufficient(balanceKobo, totalKobo);
    }
    return new MoneyError('insufficient_funds', BALANCE_CHANGED_MESSAGE, {
      ...(balanceKobo === null ? {} : { balanceKobo }),
      totalKobo,
    });
  }

  /** The provider's available balance, or null when it did not answer (the quote shows no figure). */
  private async balanceOrNull(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'walletId'>,
  ): Promise<number | null> {
    try {
      return (await this.balances.balance(wallet)).availableKobo;
    } catch {
      return null;
    }
  }

  /** One side of the payment, as the ledger records it. */
  private movement(
    p: PaymentRow,
    side: 'out' | 'in',
    status: 'pending' | 'completed' | 'failed' | 'reversed',
    figures?: { amountKobo: number; feeKobo: number; totalKobo: number },
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    } = {},
  ): LedgerMovementInput {
    const price = koboNumber(p.priceKobo);
    const providerFee = koboNumber(p.providerFeeKobo);
    const link = {
      kind: p.kind as PaymentKind,
      targetId: p.targetId,
      title: p.title,
    };
    const common = {
      status,
      category: 'purchase' as const,
      link,
      narration: PAYMENT_NARRATION,
      references: { customerReference: p.customerReference, ...refs },
      paymentId: p.id,
      source: 'send' as const,
      occurredAt: p.sentAt ?? p.createdAt,
      failureReason: status === 'failed' ? p.failureReason : null,
      // No provider here (lead ruling 6): NUV-01's LedgerService stamps the
      // running provider on every row it creates, and that is this
      // payment's own, since the sweep acts only on the running provider's
      // payments (the rollback case goes to review and writes no row).
    };
    if (side === 'out') {
      return {
        ...common,
        wallet: {
          kind: 'user',
          wawuUserId: p.payerWawuUserId ?? '',
          accountNumber: p.payerAccountNumber ?? '',
        },
        direction: 'out',
        amountKobo: figures?.amountKobo ?? price,
        // Before the provider answers: the charge the person was quoted,
        // which is what its record should say (G-39). After: its own.
        feeKobo: figures?.feeKobo ?? providerFee,
        totalKobo: figures?.totalKobo ?? price + providerFee,
        providerFeeKobo: providerFee,
        wawuFeeKobo: koboNumber(p.wawuFeeKobo),
        counterparty: {
          kind: 'wawu',
          name: null,
          accountNumber: p.merchantAccountNumber,
        },
        note: p.note,
      };
    }
    return {
      ...common,
      wallet: { kind: 'merchant', accountNumber: p.merchantAccountNumber },
      direction: 'in',
      amountKobo: figures?.amountKobo ?? price,
      feeKobo: 0,
      totalKobo: figures?.totalKobo ?? price,
      counterparty: {
        kind: 'wawu_user',
        name: null,
        wawuUserId: p.payerWawuUserId,
        accountNumber: p.payerAccountNumber,
      },
    };
  }

  /** A status change that only ever leaves `pending`. */
  private async transition(
    p: PaymentRow,
    status: PaymentStatus,
    data: Prisma.WalletPaymentUpdateManyMutationInput,
  ): Promise<PaymentRow> {
    await this.prisma.walletPayment.updateMany({
      where: { id: p.id, status: 'pending' },
      data: { ...data, status },
    });
    return this.prisma.walletPayment.findUniqueOrThrow({ where: { id: p.id } });
  }

  /**
   * Completes it (once: only from `pending`), delivers (the item stays
   * claimed until the delivery is recorded: see `fulfil`), flags a second completed payment for the same item made while
   * this one was open (lead ruling D1.4: MONEY-16 reports it, MONEY-18 owns
   * the refund).
   */
  private async complete(
    p: PaymentRow,
    discrepancy: string | null,
    handler?: PayableKindHandler,
  ): Promise<PaymentRow> {
    const now = new Date();
    // The open claim is kept until what was paid for is delivered (R2-1):
    // a buyer who has paid and not yet been given the item cannot pay for it
    // again. Nothing to deliver (no handler, no delivery, a purged payer):
    // the claim goes now.
    const owner = handler ?? this.registry.get(p.kind as PaymentKind);
    const delivers = !!owner?.onCompleted && !!p.payerWawuUserId;
    const { count } = await this.prisma.walletPayment.updateMany({
      where: { id: p.id, status: 'pending' },
      data: {
        status: 'completed',
        completedAt: now,
        ...(delivers
          ? // The request's own delivery has a minute before the sweep
            // takes it over (R3-1: the sweep's backoff starts here).
            { nextDeliveryAt: new Date(now.getTime() + MINUTE) }
          : { openKey: null }),
        reviewSince: null,
        nextCheckAt: null,
        ...(discrepancy ? { discrepancy } : {}),
      },
    });
    let row = await this.prisma.walletPayment.findUniqueOrThrow({
      where: { id: p.id },
    });
    if (count === 0) return row;
    if (row.payerWawuUserId) {
      const twins = await this.prisma.walletPayment.findMany({
        where: {
          id: { not: row.id },
          payerWawuUserId: row.payerWawuUserId,
          kind: row.kind,
          targetId: row.targetId,
          status: 'completed',
          completedAt: { gt: row.createdAt },
          createdAt: { lt: now },
        },
        select: { id: true },
      });
      if (twins.length) {
        const note = `paid twice for one item: payments ${[row.id, ...twins.map((t) => t.id)].join(', ')} were open together; one may be owed back (refund: MONEY-18)`;
        this.logger.error(`payment ${row.id}: ${note}`);
        await this.prisma.walletPayment.updateMany({
          where: { id: { in: [row.id, ...twins.map((t) => t.id)] } },
          data: { discrepancy: note.slice(0, 1000) },
        });
        row = await this.prisma.walletPayment.findUniqueOrThrow({
          where: { id: p.id },
        });
      }
    }
    const h = handler ?? this.registry.get(row.kind as PaymentKind);
    if (h) await this.fulfil(row, h);
    return row;
  }

  /** Still `pending`, out of the sweep, for a person to look at; the item stays blocked. */
  private async toReview(
    p: PaymentRow,
    discrepancy: string,
  ): Promise<PaymentRow> {
    await this.prisma.walletPayment.updateMany({
      where: { id: p.id, status: 'pending' },
      data: {
        reviewSince: new Date(),
        nextCheckAt: null,
        discrepancy: discrepancy.slice(0, 1000),
      },
    });
    return this.prisma.walletPayment.findUniqueOrThrow({ where: { id: p.id } });
  }

  /**
   * A `completed` payment, money moved and nothing delivered, that the sweep
   * stops retrying: still claimed (`openKey` kept, so the item cannot be paid
   * for again), for a person to look at. `reviewSince` is the marker.
   */
  private async toDeliveryReview(p: PaymentRow, note: string): Promise<void> {
    const { count } = await this.prisma.walletPayment.updateMany({
      where: {
        id: p.id,
        status: 'completed',
        fulfilledAt: null,
        reviewSince: null,
      },
      data: {
        reviewSince: new Date(),
        nextDeliveryAt: null,
        discrepancy: (p.discrepancy ? `${p.discrepancy}; ` : '')
          .concat(`delivery: ${note}`)
          .slice(0, 1000),
      },
    });
    if (count > 0) {
      this.logger.error(
        `payment ${p.id}: paid (${p.kind}) and not delivered: ${note}; sent to review, the item stays claimed`,
      );
    }
  }

  /** Paid payments of a kind nothing registers: to review, once, logged. */
  private async reviewUnregistered(now: Date): Promise<void> {
    const known = this.registry.kinds();
    for (let page = 0; page < SWEEP_PAGES; page += 1) {
      const stuck = await this.prisma.walletPayment.findMany({
        where: {
          status: 'completed',
          fulfilledAt: null,
          reviewSince: null,
          payerWawuUserId: { not: null },
          kind: { notIn: known },
        },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE,
      });
      for (const p of stuck) {
        await this.toDeliveryReview(
          p,
          `no feature is registered for ${p.kind} here, so nothing can deliver it (${now.toISOString()})`,
        );
      }
      if (stuck.length < SWEEP_PAGE) return;
    }
  }

  private async markFailed(
    p: PaymentRow,
    reason: string,
    writeLedger = true,
  ): Promise<PaymentRow> {
    const row = await this.transition(p, 'failed', {
      failureReason: reason,
      openKey: null,
      nextCheckAt: null,
    });
    if (writeLedger && row.status === 'failed') {
      try {
        await this.ledger.record(
          this.movement(row, 'out', 'failed'),
          undefined,
          { quiet: true },
        );
        await this.ledger.record(
          this.movement(row, 'in', 'failed'),
          undefined,
          { quiet: true },
        );
      } catch (e) {
        this.logger.error(
          `payment ${p.id}: the ledger could not record the refusal (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    return row;
  }

  /** Delivers what was paid for. True when the feature said it is done. */
  private async fulfil(
    p: PaymentRow,
    handler: PayableKindHandler,
    now = new Date(),
  ): Promise<boolean> {
    if (!handler.onCompleted || p.fulfilledAt || !p.payerWawuUserId) {
      return false;
    }
    try {
      await handler.onCompleted({
        paymentId: p.id,
        payerWawuUserId: p.payerWawuUserId,
        kind: p.kind as PaymentKind,
        targetId: p.targetId,
        priceKobo: koboNumber(p.priceKobo),
        payeeWawuUserId: p.payeeWawuUserId,
        note: p.note,
      });
      // Delivered: only now is the buyer's claim on the item given up, so
      // the feature's record of ownership is in place before another
      // payment for the item can be claimed (R2-1).
      await this.prisma.walletPayment.updateMany({
        where: { id: p.id, fulfilledAt: null },
        data: {
          fulfilledAt: new Date(),
          openKey: null,
          nextDeliveryAt: null,
        },
      });
      return true;
    } catch (e) {
      const delay = nextCheckDelayMs(p.deliveryAttempts);
      this.logger.warn(
        `payment ${p.id}: delivering ${p.kind} failed (${e instanceof Error ? e.name : 'error'}); the sweep tries again in ${Math.round(delay / MINUTE)} minutes`,
      );
      try {
        await this.prisma.walletPayment.updateMany({
          where: { id: p.id, status: 'completed', fulfilledAt: null },
          data: {
            deliveryAttempts: { increment: 1 },
            nextDeliveryAt: new Date(now.getTime() + delay),
          },
        });
      } catch {
        // The schedule is not written: the row's own due time stands and
        // the sweep tries it again after it.
      }
      return false;
    }
  }

  /** The answer this request gets, stored for every repeat of its key. */
  private async answer(
    scope: IdempotencyScope,
    p: PaymentRow,
  ): Promise<PaymentView> {
    const view = this.view(p);
    await this.keys.finish(scope, 201, successBody(view));
    return view;
  }

  view(p: PaymentRow): PaymentView {
    const providerFeeKobo = koboNumber(p.providerFeeKobo);
    const wawuFeeKobo = koboNumber(p.wawuFeeKobo);
    const status = p.status as PaymentStatus;
    return {
      id: p.id,
      kind: p.kind as PaymentKind,
      targetId: p.targetId,
      title: p.title,
      status,
      priceKobo: koboNumber(p.priceKobo),
      fee: {
        providerFeeKobo,
        wawuFeeKobo,
        totalFeeKobo: providerFeeKobo + wawuFeeKobo,
      },
      totalKobo: koboNumber(p.totalKobo),
      reference: p.customerReference,
      hold: null,
      failureReason: status === 'failed' ? p.failureReason : null,
      statusMessage: status === 'pending' ? STILL_CONFIRMING_MESSAGE : null,
      createdAt: p.createdAt.toISOString(),
      completedAt: p.completedAt ? p.completedAt.toISOString() : null,
    };
  }
}

/** What a payment quote is bound to: one kind and one item. */
export function subjectOf(kind: PaymentKind, targetId: string): string {
  return `payment:${kind}:${targetId}`;
}
