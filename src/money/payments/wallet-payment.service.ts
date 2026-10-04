import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaClient } from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import {
  FintavaError,
  type FintavaErrorKind,
} from '../../fintava/fintava-error';
import type {
  FintavaReconciliation,
  FintavaTransferReceipt,
} from '../../fintava/fintava.interface';
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
import { ledgerStatusOf } from '../ledger/ledger-webhook';
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
import { PaymentSettings, splitPrice } from './payment-config';

/** The route a payment's Idempotency-Key is scoped to. */
export const PAY_ROUTE = 'POST money/payments';

export const NOT_PAYABLE_YET_MESSAGE =
  "This can't be paid for from your wallet yet.";
export const OWN_ITEM_MESSAGE = "You can't pay yourself for this.";
/** Only when Fintava refused the transfer or said it failed: its word, not our inference. */
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
 * On `payment_in_progress` when the open payment is already paid (Fintava
 * moved the money) and what was paid for is still being delivered: the
 * item stays blocked until the delivery is recorded (lead ruling R2-1).
 */
export const FINISHING_MESSAGE =
  "Your payment went through and we're finishing it. Don't pay again.";
/** Fintava refused for funds although a fresh balance read covers the total (lead ruling D3). */
export const BALANCE_CHANGED_MESSAGE =
  'Your balance changed. Check it and try again.';
/** What Fintava sees on the transfer. Names nobody and nothing personal. */
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

/** Fintava refusals that mean no money moved and the person can fix it: the key is given back. */
const RELEASED: readonly FintavaErrorKind[] = [
  'insufficient_funds',
  'wallet_inactive',
  'not_configured',
  'auth',
  'merchant_inactive',
  'rate_limited',
  'unavailable',
];

/** A lost race on `WalletPayment.openKey`: another payment holds the item (R2-2: read through prisma-unique). */
export const isOpenKeyClash = (e: unknown) => isUniqueViolationOn(e, 'openKey');

/**
 * Pay from wallet (task MONEY-17): one way to take a payment from a
 * person's wallet for anything WAWU sells.
 *
 * - **Where the money goes.** One wallet-to-wallet transfer of the price
 *   from the buyer's Fintava wallet to WAWU's merchant wallet (R-19), under
 *   our CustomerReference `wawu-pay-<payment id>`. Fintava takes its
 *   balance-transfer charge on top (R-10), so the buyer pays the price plus
 *   the charge the fee quote showed (WALLET-15); WAWU adds no fee to a
 *   purchase. The quote is bound to the item (`payment:<kind>:<targetId>`).
 * - **The split** is recorded with the payment, of the price only (R-10):
 *   the payee's 85% rounded down, WAWU's 15% the rest (R-5). Moving the 85%
 *   to the payee is WALLET-16's (R-11); Fintava's charge on that move is
 *   WAWU's (R-31).
 * - **Once per key.** The Idempotency-Key is taken before the PIN; the
 *   payment, its pending ledger rows and the key's link to it are written in
 *   one transaction before Fintava is called (idempotency.ts).
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
 *   item, Fintava's available balance (`402 insufficient_funds` with a real
 *   shortfall; never a sum of our own records).
 * - **An unknown outcome is `pending` until Fintava says** (lead ruling D1):
 *   a timeout, a 5xx, a 2xx without a transaction, a repeated reference, and
 *   Fintava having no record of it yet. Absence is never proof that no money
 *   moved: the sweep keeps asking Fintava (lookup and the buyer's history,
 *   backing off to hourly), never sends again and never refunds; past
 *   PAYMENT_REVIEW_AFTER_HOURS it goes to manual review, still `pending`.
 *   Only Fintava's own refusal or its FAILURE makes a payment `failed`.
 * - **Settled at once.** A ledger row of the payment settled by anything
 *   (a webhook, MONEY-08's status check, a reversal) settles the payment in
 *   the same breath (`LedgerService.onPaymentSettled`); the sweep is the
 *   fallback.
 * - **Fintava's figures are the record.** The ledger rows are written with
 *   the quoted figures before the send and Fintava's figures after; any
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
    private readonly fintava: FintavaClient,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly balances: WalletBalanceService,
    private readonly merchant: MerchantWallet,
    private readonly registry: PayableRegistry,
    private readonly keys: IdempotencyService,
    private readonly settings: PaymentSettings,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` by a request that died (a restart mid-send)
    // is answered from its payment once the send can no longer be running.
    this.keys.onStale(
      PAY_ROUTE,
      this.fintava.settings.moneyTimeoutMs + MINUTE,
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
      fee,
      await this.balanceOrNull(wallet),
    );
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

    // Fintava's balance, never ours: a 503 or a 423 here moves nothing.
    const { availableKobo } = await this.balances.balance(wallet);
    if (availableKobo < fee.totalKobo) {
      throw this.insufficient(availableKobo, fee.totalKobo);
    }
    const merchant = await this.merchant.account();
    if (merchant === wallet.accountNumber) {
      this.logger.error('payment: the payer wallet is WAWU merchant wallet');
      throw new MoneyError(
        'provider_unreachable',
        PAYMENTS_UNAVAILABLE_MESSAGE,
        { retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds },
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
      status: 'pending',
      openKey,
      nextCheckAt: new Date(now.getTime() + MINUTE),
      note: dto.note?.trim() ? dto.note.trim() : null,
      sentAt: now,
    };

    // The CLAIM: the payment, its pending ledger rows and the key's link to
    // it, in one transaction, before Fintava is called (a crash after the
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

    let receipt: FintavaTransferReceipt;
    try {
      receipt = await this.fintava.walletToWallet({
        senderAccountNumber: wallet.accountNumber,
        receiverAccountNumber: payment.merchantAccountNumber,
        amountKobo: price,
        customerReference: payment.customerReference,
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
        return await this.prisma.$transaction(async (tx) => {
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
        fresh,
        await this.balanceOrNull(wallet),
      ),
    });
  }

  /** Fintava did not take the payment, or we do not know whether it did. */
  private async afterRefusal(
    payment: PaymentRow,
    scope: IdempotencyScope,
    e: unknown,
    wallet: OpenWallet,
  ): Promise<PaymentView> {
    const fintavaError = e instanceof FintavaError ? e : null;
    if (!fintavaError || fintavaError.recordMayExist) {
      // Money may have moved. Pending until Fintava says; nothing is sent
      // again from here.
      this.logger.warn(
        `payment ${payment.id}: outcome unknown (${fintavaError?.kind ?? 'error'}); pending until Fintava says`,
      );
      return this.answer(scope, payment);
    }
    const failed = await this.markFailed(payment, PAYMENT_FAILED_REASON);
    if (RELEASED.includes(fintavaError.kind)) {
      // Nothing moved and the person can fix the cause: the key is given
      // back so the same payment can be sent again (CONVENTIONS section 4).
      await this.keys.release(scope);
      if (fintavaError.kind === 'insufficient_funds') {
        throw this.fintavaSaidInsufficient(
          await this.balanceOrNull(wallet),
          koboNumber(payment.totalKobo),
        );
      }
      if (fintavaError.kind === 'wallet_inactive') {
        throw fintavaError.toHttpException();
      }
      throw new MoneyError(
        'provider_unreachable',
        PAYMENTS_UNAVAILABLE_MESSAGE,
        { retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds },
      );
    }
    this.logger.warn(
      `payment ${payment.id}: Fintava refused it (${fintavaError.kind}); nothing moved`,
    );
    return this.answer(scope, failed);
  }

  /** Fintava accepted the transfer and said what it took. */
  private async afterReceipt(
    payment: PaymentRow,
    scope: IdempotencyScope,
    receipt: FintavaTransferReceipt,
    handler: PayableKindHandler,
  ): Promise<PaymentView> {
    const notes: string[] = [];
    const refs = {
      fintavaReference: receipt.fintavaReference,
      tagapayTransRef: receipt.tagapayTransRef,
      fintavaTransactionId: receipt.transactionId,
    };
    try {
      const out = await this.ledger.record(
        this.movement(
          payment,
          'out',
          'completed',
          {
            amountKobo: receipt.amountKobo,
            feeKobo: receipt.feeKobo,
            totalKobo: receipt.totalKobo,
          },
          refs,
        ),
        undefined,
        { quiet: true },
      );
      const inn = await this.ledger.record(
        this.movement(
          payment,
          'in',
          'completed',
          {
            amountKobo: receipt.amountKobo,
            feeKobo: 0,
            totalKobo: receipt.amountKobo,
          },
          refs,
        ),
        undefined,
        { quiet: true },
      );
      if (out.discrepancy) notes.push(out.discrepancy);
      if (inn.discrepancy) notes.push(inn.discrepancy);
    } catch (e) {
      // The money moved; the webhook and the status check will write the
      // ledger. The payment's own status is Fintava's receipt.
      this.logger.error(
        `payment ${payment.id}: the ledger could not record the receipt (${e instanceof Error ? e.name : 'error'})`,
      );
    }
    const discrepancy = notes.length ? notes.join('; ').slice(0, 1000) : null;
    let row: PaymentRow;
    if (receipt.amountKobo === koboNumber(payment.priceKobo)) {
      row = await this.complete(payment, discrepancy, handler);
    } else {
      // Fintava moved another amount than the price: a stop. The payment
      // goes to review (still pending, nothing delivered).
      this.logger.error(
        `payment ${payment.id}: Fintava moved another amount than the price; sent to review`,
      );
      row = await this.toReview(
        payment,
        discrepancy ??
          `amountKobo ${payment.priceKobo} vs ${receipt.amountKobo}`,
      );
    }
    return this.answer(scope, row);
  }

  // -------------------------------------------------------------------------
  // Settling payments whose answer was lost, and delivering what was paid for
  // -------------------------------------------------------------------------

  /**
   * Every minute: every pending payment due a check (not under review), in
   * the order of its next check, paged by key so none waits behind another;
   * then every completed payment not yet delivered. A payment still unknown
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

      const kinds = this.registry
        .kinds()
        .filter((k) => typeof this.registry.get(k)?.onCompleted === 'function');
      let cursor: string | null = null;
      for (let page = 0; kinds.length && page < SWEEP_PAGES; page += 1) {
        const owed: PaymentRow[] = await this.prisma.walletPayment.findMany({
          where: {
            status: 'completed',
            fulfilledAt: null,
            kind: { in: kinds },
            // The delivery the completion itself started has had a minute:
            // only a delivery that failed or died is tried again here.
            completedAt: { lt: new Date(now.getTime() - MINUTE) },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: SWEEP_PAGE,
        });
        for (const p of owed) {
          const handler = this.registry.get(p.kind as PaymentKind);
          if (handler && (await this.fulfil(p, handler))) counts.delivered += 1;
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
   * Settles one pending payment from what is known: its buyer-side ledger
   * row when that is settled, else Fintava itself (by our reference, then
   * the buyer's history). `ask`: whether to ask Fintava (the sweep) or only
   * read the ledger (the ledger listener).
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
      return (await this.complete(p, null)).status as PaymentStatus;
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
    // Pending, a disagreement held for review, or failed only because
    // Fintava had no record of it yet: never proof that no money moved.
    // Fintava is asked.
    if (!ask) return 'pending';
    const answer = await this.askFintava(p);
    if (answer?.state === 'found') {
      const t = answer.transaction;
      const status = ledgerStatusOf(t.status);
      const price = koboNumber(p.priceKobo);
      if (status === 'completed' && t.amountKobo === price) {
        await this.recordSighting(p, row, 'completed', t, answer.source);
        return (await this.complete(p, null)).status as PaymentStatus;
      }
      if (status === 'completed') {
        return (
          await this.toReview(
            p,
            `Fintava moved ${t.amountKobo} kobo for a price of ${price}`,
          )
        ).status as PaymentStatus;
      }
      if (status === 'failed') {
        await this.recordSighting(p, row, 'failed', t, answer.source);
        return (await this.markFailed(p, PAYMENT_FAILED_REASON, false))
          .status as PaymentStatus;
      }
    }
    await this.reschedule(p, now);
    return 'pending';
  }

  /** What Fintava knows of the payment's transfer, or null when it cannot be asked. */
  private async askFintava(
    p: PaymentRow,
  ): Promise<FintavaReconciliation | null> {
    const wallet = p.payerAccountNumber
      ? await this.prisma.fintavaWallet.findUnique({
          where: { accountNumber: p.payerAccountNumber },
          select: { customerId: true },
        })
      : null;
    if (!wallet) return null;
    try {
      return await this.fintava.reconcile(
        p.customerReference,
        { kind: 'customer', customerId: wallet.customerId },
        p.sentAt ?? p.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `payment ${p.id}: Fintava could not be asked (${e instanceof FintavaError ? e.kind : 'error'})`,
      );
      return null;
    }
  }

  /**
   * Fintava's record of the transfer onto both ledger sides (a revival when
   * the row was failed as absent), with the row's own fee: lookups and
   * history carry none for a wallet-to-wallet send (MONEY-08's rule).
   */
  private async recordSighting(
    p: PaymentRow,
    out: { feeKobo: bigint; totalKobo: bigint } | null,
    status: 'completed' | 'failed',
    t: {
      amountKobo: number;
      fintavaReference: string | null;
      tagapayTransRef: string | null;
      id: string;
      createdAt: string;
    },
    source: 'lookup' | 'history',
  ): Promise<void> {
    if (!p.payerAccountNumber) return;
    const refs = {
      fintavaReference: t.fintavaReference,
      tagapayTransRef: t.tagapayTransRef,
      fintavaTransactionId: t.id,
    };
    const occurredAt = Number.isNaN(Date.parse(t.createdAt))
      ? null
      : new Date(t.createdAt);
    try {
      const fee = out ? koboNumber(out.feeKobo) : koboNumber(p.providerFeeKobo);
      const total = out ? koboNumber(out.totalKobo) : koboNumber(p.totalKobo);
      await this.ledger.record(
        {
          ...this.movement(
            p,
            'out',
            status,
            {
              amountKobo: t.amountKobo,
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
              amountKobo: t.amountKobo,
              feeKobo: 0,
              totalKobo: t.amountKobo,
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
        `payment ${p.id}: the ledger could not record Fintava's record (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** Still unknown: asked again later, or sent to review past the bound. */
  private async reschedule(p: PaymentRow, now: Date): Promise<void> {
    const sent = (p.sentAt ?? p.createdAt).getTime();
    if (now.getTime() - sent >= this.settings.reviewAfterHours * 3_600_000) {
      await this.toReview(
        p,
        `no answer from Fintava after ${this.settings.reviewAfterHours} hours`,
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
   * Fintava refused for funds after our read said there was enough (lead
   * ruling D3): a real shortfall on a fresh read is shown; otherwise the
   * balance moved or Fintava took more than quoted, and nothing below 1 kobo
   * is ever shown as a shortfall.
   */
  private fintavaSaidInsufficient(
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

  /** Fintava's available balance, or null when it did not answer (the quote shows no figure). */
  private async balanceOrNull(
    wallet: Pick<OpenWallet, 'walletId'>,
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
    status: 'pending' | 'completed' | 'failed',
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
        // Before Fintava answers: the charge the person was quoted, which is
        // what Fintava's record should say (G-39). After: Fintava's own.
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
        ...(delivers ? {} : { openKey: null }),
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
        data: { fulfilledAt: new Date(), openKey: null },
      });
      return true;
    } catch (e) {
      this.logger.warn(
        `payment ${p.id}: delivering ${p.kind} failed (${e instanceof Error ? e.name : 'error'}); the sweep tries again`,
      );
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
