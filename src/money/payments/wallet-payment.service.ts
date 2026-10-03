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
import type { FintavaTransferReceipt } from '../../fintava/fintava.interface';
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
  LEDGER_ABSENT_FAILURE,
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
import { splitPrice } from './payment-config';

/** The route a payment's Idempotency-Key is scoped to. */
export const PAY_ROUTE = 'POST money/payments';

export const NOT_PAYABLE_YET_MESSAGE =
  "This can't be paid for from your wallet yet.";
export const OWN_ITEM_MESSAGE = "You can't pay yourself for this.";
export const PAYMENT_FAILED_REASON =
  'The payment did not go through. No money left your wallet.';
/**
 * A payment failed because Fintava had no record of it past the resend
 * window (the ledger's LEDGER_ABSENT_FAILURE, MONEY-08): our inference, not
 * Fintava's word, so the only failure a later sighting may undo.
 */
export const PAYMENT_ABSENT_REASON =
  'The payment did not reach the bank. No money left your wallet.';
export const INSUFFICIENT_FALLBACK_MESSAGE =
  'There is not enough money in your wallet for this.';
/** What Fintava sees on the transfer. Names nobody and nothing personal. */
export const PAYMENT_NARRATION = 'WAWU purchase';

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

/**
 * Pay from wallet (task MONEY-17): one way to take a payment from a
 * person's wallet for anything WAWU sells.
 *
 * - **Where the money goes.** One wallet-to-wallet transfer of the price
 *   from the buyer's Fintava wallet to WAWU's merchant wallet (R-19), under
 *   our CustomerReference `wawu-pay-<payment id>`. Fintava takes its
 *   balance-transfer charge on top (R-10), so the buyer pays the price plus
 *   the charge the fee quote showed (WALLET-15); WAWU adds no fee to a
 *   purchase.
 * - **The split** is recorded with the payment, of the price only (R-10):
 *   the payee's 85% rounded down, WAWU's 15% the rest (R-5). Moving the 85%
 *   to the payee is WALLET-16's (R-11); Fintava's charge on that move is
 *   WAWU's (R-31).
 * - **Once.** The Idempotency-Key row and the payment, with its pending
 *   ledger rows, are written in one transaction before Fintava is called;
 *   the key's primary key is the lock (idempotency.ts). A repeat is
 *   answered from the stored answer and never reaches Fintava.
 * - **Before money moves**, in order: the wallet (gate), the key, the PIN
 *   (guards), the body, the target and its price (the owning feature,
 *   PayableRegistry), the quote (`FeeQuoteService.check`, `409
 *   quote_changed` with the new payment quote), the merchant cap, Fintava's
 *   available balance (`402 insufficient_funds` with the shortfall; never
 *   a sum of our own records). None of these stores anything.
 * - **An unknown outcome** (Fintava timed out, a 5xx, a 2xx without a
 *   transaction, a repeated reference) is `pending`, never retried here and
 *   never refunded: the ledger's status check (MONEY-08) asks Fintava by our
 *   reference and this service's sweep copies what it learns onto the
 *   payment (FIX-01).
 * - **Fintava's figures are the record.** The ledger rows are written with
 *   the quoted figures before the send and Fintava's figures after; any
 *   difference is kept on the row's `discrepancy` and on the payment, for
 *   MONEY-16 to report (a stop, not a fix).
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
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` by a request that died (a restart mid-send)
    // is answered from its payment once the send can no longer be running.
    this.keys.onStale(
      PAY_ROUTE,
      this.fintava.settings.moneyTimeoutMs + 60_000,
      async (row) => {
        const p = row.resourceId
          ? await this.prisma.walletPayment.findUnique({
              where: { id: row.resourceId },
            })
          : null;
        return p ? { status: 201, body: successBody(this.view(p)) } : null;
      },
    );
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
    const fee = this.fees.quote(wallet.wawuUserId, {
      kind: 'purchase',
      amountKobo: target.priceKobo,
    });
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
    const input = { kind: 'purchase' as const, amountKobo: price };

    let fee: FeeQuoteView;
    try {
      fee = this.fees.check(
        payer,
        input,
        dto.expectedTotalKobo,
        dto.quoteToken,
      );
    } catch (e) {
      if (e instanceof MoneyError && e.code === 'quote_changed') {
        const fresh = this.fees.quote(payer, input);
        throw new MoneyError('quote_changed', QUOTE_CHANGED_MESSAGE, {
          paymentQuote: this.quoteView(
            dto.kind,
            dto.targetId,
            target,
            fresh,
            await this.balanceOrNull(wallet),
          ),
        });
      }
      throw e;
    }

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
        {
          retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
        },
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
      note: dto.note?.trim() ? dto.note.trim() : null,
      sentAt: now,
    };

    // The payment, its pending ledger rows and the key's link to it, in one
    // transaction, before Fintava is called: a crash after the send still
    // leaves a row the status check settles, and a repeat of the key is
    // answered from this payment.
    const payment = await this.prisma.$transaction(async (tx) => {
      await this.keys.attach(tx, scope, id);
      const row = await tx.walletPayment.create({ data });
      await this.ledger.record(this.movement(row, 'out', 'pending'), tx);
      await this.ledger.record(this.movement(row, 'in', 'pending'), tx);
      return row;
    });

    let receipt: FintavaTransferReceipt;
    try {
      receipt = await this.fintava.walletToWallet({
        senderAccountNumber: payment.payerAccountNumber,
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

  /** Fintava did not take the payment, or we do not know whether it did. */
  private async afterRefusal(
    payment: PaymentRow,
    scope: IdempotencyScope,
    e: unknown,
    wallet: OpenWallet,
  ): Promise<PaymentView> {
    const fintavaError = e instanceof FintavaError ? e : null;
    if (!fintavaError || fintavaError.recordMayExist) {
      // Money may have moved. Pending: the ledger's status check asks
      // Fintava by our reference; nothing is sent again from here.
      this.logger.warn(
        `payment ${payment.id}: outcome unknown (${fintavaError?.kind ?? 'error'}); left pending for the status check`,
      );
      return this.answer(scope, payment);
    }
    const failed = await this.markFailed(payment, PAYMENT_FAILED_REASON);
    if (RELEASED.includes(fintavaError.kind)) {
      // Nothing moved and the person can fix the cause: the key is given
      // back so the same payment can be sent again (CONVENTIONS section 4).
      await this.keys.release(scope);
      if (fintavaError.kind === 'insufficient_funds') {
        const balance = await this.balanceOrNull(wallet);
        const total = koboNumber(payment.totalKobo);
        throw balance === null
          ? new MoneyError(
              'insufficient_funds',
              INSUFFICIENT_FALLBACK_MESSAGE,
              {
                totalKobo: total,
              },
            )
          : this.insufficient(balance, total);
      }
      if (fintavaError.kind === 'wallet_inactive') {
        throw fintavaError.toHttpException();
      }
      throw new MoneyError(
        'provider_unreachable',
        PAYMENTS_UNAVAILABLE_MESSAGE,
        {
          retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
        },
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
      row = await this.markCompleted(payment, discrepancy);
    } else {
      // Fintava moved another amount than the price: a stop. The payment
      // stays pending, the difference is kept, nothing is delivered.
      this.logger.error(
        `payment ${payment.id}: Fintava moved another amount than the price; left pending for review`,
      );
      row = await this.noteDiscrepancy(
        payment,
        discrepancy ??
          `amountKobo ${payment.priceKobo} vs ${receipt.amountKobo}`,
      );
    }
    if (row.status === 'completed') await this.fulfil(row, handler);
    return this.answer(scope, row);
  }

  // -------------------------------------------------------------------------
  // Settling payments whose answer was lost, and delivering what was paid for
  // -------------------------------------------------------------------------

  /**
   * Every minute: each pending payment sent more than a minute ago takes the
   * status of its buyer-side ledger row, which MONEY-08's status check and
   * Fintava's webhooks settle (it never asks Fintava itself and never sends
   * money); a payment failed because Fintava had no record of it is brought
   * back if that row was revived (Fintava's record wins); and a completed
   * payment whose delivery failed is delivered again.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-payment-settle' })
  async sweep(
    now = new Date(),
  ): Promise<{ settled: number; delivered: number }> {
    if (this.sweeping) return { settled: 0, delivered: 0 };
    this.sweeping = true;
    let settled = 0;
    let delivered = 0;
    try {
      const due = await this.prisma.walletPayment.findMany({
        where: {
          OR: [
            {
              status: 'pending',
              sentAt: { lt: new Date(now.getTime() - 60_000) },
            },
            {
              status: 'failed',
              failureReason: PAYMENT_ABSENT_REASON,
              updatedAt: { gt: new Date(now.getTime() - 72 * 3_600_000) },
            },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: { id: true },
      });
      for (const { id } of due) {
        const before = await this.prisma.walletPayment.findUnique({
          where: { id },
        });
        const after = await this.settle(id);
        if (before && after && before.status !== after) settled += 1;
      }
      const kinds = this.registry
        .kinds()
        .filter((k) => typeof this.registry.get(k)?.onCompleted === 'function');
      if (kinds.length) {
        const owed = await this.prisma.walletPayment.findMany({
          where: {
            status: 'completed',
            fulfilledAt: null,
            kind: { in: kinds },
          },
          orderBy: { completedAt: 'asc' },
          take: 50,
        });
        for (const p of owed) {
          const handler = this.registry.get(p.kind as PaymentKind);
          if (handler && (await this.fulfil(p, handler))) delivered += 1;
        }
      }
    } catch (e) {
      this.logger.error(
        `payment sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return { settled, delivered };
  }

  /** One payment takes its buyer-side ledger row's status. */
  async settle(paymentId: string): Promise<PaymentStatus | null> {
    const p = await this.prisma.walletPayment.findUnique({
      where: { id: paymentId },
    });
    if (!p) return null;
    const absentFailed =
      p.status === 'failed' && p.failureReason === PAYMENT_ABSENT_REASON;
    if (p.status !== 'pending' && !absentFailed)
      return p.status as PaymentStatus;
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: {
        customerReference: p.customerReference,
        accountNumber: p.payerAccountNumber,
        direction: 'out',
      },
    });
    if (!row) return p.status as PaymentStatus;
    if (row.discrepancy && row.discrepancy !== p.discrepancy) {
      await this.prisma.walletPayment.update({
        where: { id: p.id },
        data: { discrepancy: row.discrepancy.slice(0, 1000) },
      });
    }
    let next: PaymentRow = p;
    if (row.status === 'completed' && !row.discrepancy) {
      next = await this.markCompleted(p, null, absentFailed);
      if (absentFailed && next.status === 'completed') {
        this.logger.warn(
          `payment ${p.id}: failed as unknown to Fintava, now found completed; brought back`,
        );
      }
    } else if (row.status === 'failed' && !absentFailed) {
      next = await this.markFailed(
        p,
        row.failureReason === LEDGER_ABSENT_FAILURE
          ? PAYMENT_ABSENT_REASON
          : PAYMENT_FAILED_REASON,
        false,
      );
    } else if (row.status === 'reversed' && !absentFailed) {
      next = await this.transition(p, 'reversed', {});
    }
    if (next.status === 'completed' && p.status !== 'completed') {
      const handler = this.registry.get(next.kind as PaymentKind);
      if (handler) await this.fulfil(next, handler);
    }
    return next.status as PaymentStatus;
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

  private insufficient(balanceKobo: number, totalKobo: number): MoneyError {
    const shortfallKobo = Math.max(0, totalKobo - balanceKobo);
    return new MoneyError(
      'insufficient_funds',
      `You need ${nairaText(shortfallKobo)} more in your wallet.`,
      { balanceKobo, totalKobo, shortfallKobo },
    );
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
          wawuUserId: p.payerWawuUserId,
          accountNumber: p.payerAccountNumber,
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

  /** A status change that only ever leaves `pending` (or a failure-as-absent). */
  private async transition(
    p: PaymentRow,
    status: PaymentStatus,
    data: Prisma.WalletPaymentUpdateManyMutationInput,
    from: string[] = ['pending'],
  ): Promise<PaymentRow> {
    await this.prisma.walletPayment.updateMany({
      where: { id: p.id, status: { in: from } },
      data: { ...data, status },
    });
    return this.prisma.walletPayment.findUniqueOrThrow({ where: { id: p.id } });
  }

  private markCompleted(
    p: PaymentRow,
    discrepancy: string | null,
    fromAbsentFailure = false,
  ): Promise<PaymentRow> {
    return this.transition(
      p,
      'completed',
      {
        completedAt: new Date(),
        failureReason: null,
        ...(discrepancy ? { discrepancy } : {}),
      },
      fromAbsentFailure ? ['failed'] : ['pending'],
    );
  }

  private async markFailed(
    p: PaymentRow,
    reason: string,
    writeLedger = true,
  ): Promise<PaymentRow> {
    const row = await this.transition(p, 'failed', { failureReason: reason });
    if (writeLedger && row.status === 'failed') {
      try {
        await this.ledger.record(this.movement(row, 'out', 'failed'));
        await this.ledger.record(this.movement(row, 'in', 'failed'));
      } catch (e) {
        this.logger.error(
          `payment ${p.id}: the ledger could not record the refusal (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    return row;
  }

  private async noteDiscrepancy(
    p: PaymentRow,
    discrepancy: string,
  ): Promise<PaymentRow> {
    return this.prisma.walletPayment.update({
      where: { id: p.id },
      data: { discrepancy: discrepancy.slice(0, 1000) },
    });
  }

  /** Delivers what was paid for. True when the feature said it is done. */
  private async fulfil(
    p: PaymentRow,
    handler: PayableKindHandler,
  ): Promise<boolean> {
    if (!handler.onCompleted || p.fulfilledAt) return false;
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
      await this.prisma.walletPayment.updateMany({
        where: { id: p.id, fulfilledAt: null },
        data: { fulfilledAt: new Date() },
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
    return {
      id: p.id,
      kind: p.kind as PaymentKind,
      targetId: p.targetId,
      title: p.title,
      status: p.status as PaymentStatus,
      priceKobo: koboNumber(p.priceKobo),
      fee: {
        providerFeeKobo,
        wawuFeeKobo,
        totalFeeKobo: providerFeeKobo + wawuFeeKobo,
      },
      totalKobo: koboNumber(p.totalKobo),
      reference: p.customerReference,
      hold: null,
      failureReason: p.failureReason,
      createdAt: p.createdAt.toISOString(),
      completedAt: p.completedAt ? p.completedAt.toISOString() : null,
    };
  }
}
