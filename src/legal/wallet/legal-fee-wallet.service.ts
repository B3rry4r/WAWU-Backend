import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { LegalRequest } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { MoneyError } from '../../money/money-error';
import type { PaymentView } from '../../money/money-view.type';
import { deliverOrRefund } from '../../money/payments/deliver-or-refund';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import { UNPAID_HOLD_MINUTES } from '../legal.service';
import type { LegalFeeWalletDto } from './legal-fee-wallet.dto';
import type {
  LegalFeeStage,
  LegalFeeWalletQuoteView,
  LegalFeeWalletStatus,
  LegalFeeWalletView,
} from './legal-fee-wallet-view.type';

/** The route a wallet legal fee's Idempotency-Key is scoped to. */
export const LEGAL_FEE_WALLET_ROUTE = 'POST legal/requests/:id/pay/wallet';

/** The payment kind this feature sells (docs/contract/WALLET.md). */
export const LEGAL_FEE_KIND = 'legal_fee';

/** The hold's `releaseCondition` for a legal fee that is being paid back. */
export const LEGAL_FEE_REFUND_CONDITION = 'legal_fee_applied';

const KOBO_PER_NAIRA = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LEGAL_REQUEST_NOT_FOUND = 'Legal request not found.';
export const LEGAL_PAYMENT_NOT_FOUND = 'We could not find that payment.';
export const LEGAL_NOTHING_DUE = 'There is no fee to pay on this request now.';
export const LEGAL_BOOKING_EXPIRED =
  'This booking has expired. Please pick a time again.';

/** The reference the request carries in place of a Flutterwave charge's (the columns are unique). */
export const legalTxRef = (paymentId: string) => `wallet:${paymentId}`;

/** The fee that is due on a request now, or why none is. */
export type FeeDue =
  | { due: true; stage: LegalFeeStage; feeNaira: number }
  | { due: false; why: string };

/**
 * Which fee a request owes now (LEGAL-05, R-14): the consultation fee WAWU
 * set in admin when the hour was booked (LEGAL-03 recorded it on the request),
 * or the quoted fee for the work once the engagement letter is signed.
 * Nothing here reads a price list: the price is the one on the request.
 */
export function feeDue(r: LegalRequest, now = new Date()): FeeDue {
  if (r.status === 'cancelled') {
    return { due: false, why: 'This request was cancelled.' };
  }
  if (
    r.path === 'consultation' &&
    !r.consultationPaidAt &&
    r.status === 'awaiting_consultation_payment'
  ) {
    if (r.consultationFee === null || r.consultationFee < 1) {
      return {
        due: false,
        why: 'This consultation is priced per matter and arranged with you directly.',
      };
    }
    if (r.consultationMedium !== 'physical') {
      if (r.scheduledFor === null) {
        return { due: false, why: LEGAL_BOOKING_EXPIRED };
      }
      if (
        r.updatedAt.getTime() <
        now.getTime() - UNPAID_HOLD_MINUTES * 60_000
      ) {
        return { due: false, why: LEGAL_BOOKING_EXPIRED };
      }
    }
    return { due: true, stage: 'consultation', feeNaira: r.consultationFee };
  }
  if (
    r.quoteAmount !== null &&
    r.quoteAmount > 0 &&
    r.contractSignedAt &&
    !r.servicePaidAt &&
    (r.status === 'contract_signed' || r.status === 'awaiting_service_payment')
  ) {
    return { due: true, stage: 'service', feeNaira: r.quoteAmount };
  }
  if (r.quoteAmount !== null && !r.contractSignedAt && !r.servicePaidAt) {
    return {
      due: false,
      why: 'You need to read and sign the engagement letter before paying for this work.',
    };
  }
  return { due: false, why: LEGAL_NOTHING_DUE };
}

/**
 * Pay a legal fee from the wallet (task LEGAL-05, S19, S22, S26). The web's
 * Flutterwave routes (`/consultation`, `/consultation/verify`,
 * `/payment/init`, `/payment/verify`) are unchanged.
 *
 * - **The payment is MONEY-17's.** A legal fee is a wallet payment of kind
 *   `legal_fee` whose target is the request's id, into WAWU's own account: it
 *   is WAWU's own sale, so there is no seller split and nothing is held. The
 *   provider's charge goes on top (R-10), read from the fee settings by the
 *   payment service; the quote, the PIN, the Idempotency-Key, the daily limit
 *   and the provider seam (R-39) are all the payment service's.
 * - **The price is the one WAWU set in admin (R-14), recorded on the request
 *   when it was booked or quoted** (`consultationFee`, `quoteAmount`); the
 *   client never names an amount. The quote is bound to the stage and the fee
 *   (`terms`): a request re-booked or re-quoted since is `409 quote_changed`.
 * - **Applied once per payment.** `onCompleted` runs in the request and again
 *   from the payment sweep until it has succeeded, on any server. It marks
 *   the stage paid with ONE conditional write (`consultationPaidAt` or
 *   `servicePaidAt` still null) and records the payment's reference on the
 *   request (`wallet:<payment id>`, unique); a repeat writes nothing.
 * - **A fee that cannot be applied is paid back** (the request was cancelled,
 *   the booked hour was given up while the debit was confirming, or the same
 *   fee was paid another way): the price and the charge go back through MONEY-18's refund,
 *   decided in one short transaction that excludes the grant.
 */
@Injectable()
export class LegalFeeWalletService implements OnModuleInit {
  private readonly logger = new Logger(LegalFeeWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: LEGAL_FEE_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(LEGAL_FEE_WALLET_ROUTE, (view) =>
      this.present(view),
    );
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** The pay sheet: the fee that is due, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    requestId: string,
  ): Promise<LegalFeeWalletQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: LEGAL_FEE_KIND,
      targetId: requestId,
    });
    const record = await this.prisma.legalRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const due = feeDue(record);
    return {
      requestId,
      stage: due.due ? due.stage : 'service',
      title: payment.title,
      priceKobo: payment.priceKobo,
      payment,
    };
  }

  /**
   * Pays the fee that is due from the wallet. The answer, and every replay
   * of the request's key, is the payment as `present` builds it.
   */
  async pay(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    requestId: string,
    dto: LegalFeeWalletDto,
  ): Promise<LegalFeeWalletView> {
    const payment = await this.payments.pay(
      wallet,
      {
        kind: LEGAL_FEE_KIND,
        targetId: requestId,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as LegalFeeWalletView | undefined) ??
      this.present(payment)
    );
  }

  /** One legal fee payment as it stands now. Only the payer reads it, for the request in the path. */
  async read(
    wawuUserId: string,
    requestId: string,
    id: string,
  ): Promise<LegalFeeWalletView> {
    const payment = await this.prisma.walletPayment.findFirst({
      where: {
        id,
        payerWawuUserId: wawuUserId,
        kind: LEGAL_FEE_KIND,
        targetId: requestId,
      },
    });
    if (!payment) throw new MoneyError('not_found', LEGAL_PAYMENT_NOT_FOUND);
    return this.present(this.payments.view(payment, null));
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the fee that is due. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    if (!UUID.test(lookup.targetId))
      throw new MoneyError('target_not_found', LEGAL_REQUEST_NOT_FOUND);
    const record = await this.prisma.legalRequest.findUnique({
      where: { id: lookup.targetId },
    });
    if (!record || record.wawuUserId !== lookup.payerWawuUserId)
      throw new MoneyError('target_not_found', LEGAL_REQUEST_NOT_FOUND);
    const due = feeDue(record);
    if (!due.due) throw new MoneyError('target_not_payable', due.why);
    return {
      title:
        due.stage === 'consultation'
          ? `${record.serviceName} consultation`
          : record.serviceName,
      priceKobo: due.feeNaira * KOBO_PER_NAIRA,
      payee: null,
      // The goods the quote promised: the stage and the fee. A request
      // re-booked or re-quoted since is a quote that changed.
      terms: { stage: due.stage, feeNaira: due.feeNaira },
    };
  }

  /**
   * The payment is confirmed: mark the fee paid once, or pay it back when it
   * cannot be applied. Idempotent and safe on two servers at once.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const ref = legalTxRef(payment.paymentId);
    const stage = payment.terms?.stage;
    if (stage !== 'consultation' && stage !== 'service')
      throw new Error(`Payment ${payment.paymentId} names no legal fee stage.`);
    const result = await deliverOrRefund(this.prisma, this.holds, payment, {
      condition: LEGAL_FEE_REFUND_CONDITION,
      refusal: async (tx) => {
        const r = await tx.legalRequest.findUnique({
          where: { id: payment.targetId },
        });
        if (!r) return 'the request is gone';
        if (r.status === 'cancelled') return 'the request was cancelled';
        if (stage === 'consultation') {
          if (r.consultationTxRef === ref) return null;
          if (r.consultationPaidAt)
            return 'the consultation was paid another way';
          if (r.consultationMedium !== 'physical' && r.scheduledFor === null)
            return 'the booked hour was given up';
          if (r.consultationFee !== payment.priceKobo / KOBO_PER_NAIRA)
            return 'the consultation fee changed';
          // The grant below needs the request still waiting for this fee; a
          // request moved to another state by hand would never take it.
          if (r.status !== 'awaiting_consultation_payment')
            return 'the request is no longer waiting for the consultation fee';
          return null;
        }
        if (r.serviceTxRef === ref) return null;
        if (r.servicePaidAt) return 'the work was paid another way';
        if (r.quoteAmount !== payment.priceKobo / KOBO_PER_NAIRA)
          return 'the quote changed';
        return null;
      },
      grant: async (tx) => {
        const now = new Date();
        if (stage === 'consultation') {
          const { count } = await tx.legalRequest.updateMany({
            where: {
              id: payment.targetId,
              consultationPaidAt: null,
              status: 'awaiting_consultation_payment',
            },
            data: {
              consultationPaidAt: now,
              consultationTxRef: ref,
              status: 'consultation_scheduled',
            },
          });
          return count > 0;
        }
        const { count } = await tx.legalRequest.updateMany({
          where: {
            id: payment.targetId,
            servicePaidAt: null,
            contractSignedAt: { not: null },
          },
          data: {
            servicePaidAt: now,
            serviceTxRef: ref,
            status: 'in_progress',
          },
        });
        return count > 0;
      },
    });
    if (result.outcome === 'refund') {
      this.logger.warn(
        `payment ${payment.paymentId}: the legal fee could not be applied (${result.why}); the price is going back`,
      );
      return;
    }
    if (!result.granted) {
      // Nothing changed: it was applied already by this payment, or the
      // request moved under it. The next look (the refusal) settles which.
      const r = await this.prisma.legalRequest.findUnique({
        where: { id: payment.targetId },
        select: { consultationTxRef: true, serviceTxRef: true },
      });
      const ref2 = legalTxRef(payment.paymentId);
      if (r?.consultationTxRef !== ref2 && r?.serviceTxRef !== ref2) {
        throw new Error(
          `Payment ${payment.paymentId}: the request moved while the fee was applied; looking again.`,
        );
      }
    }
    this.logger.log(`payment ${payment.paymentId}: legal fee applied`);
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The payment as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<LegalFeeWalletView> {
    if (view.kind !== LEGAL_FEE_KIND)
      throw new Error(`Payment ${view.id} is not a legal fee payment.`);
    const ref = legalTxRef(view.id);
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: view.targetId },
    });
    const applied =
      request !== null &&
      (request.consultationTxRef === ref || request.serviceTxRef === ref);
    const stage: LegalFeeStage =
      request?.serviceTxRef === ref
        ? 'service'
        : request?.consultationTxRef === ref
          ? 'consultation'
          : view.title.endsWith(' consultation')
            ? 'consultation'
            : 'service';
    const payback = applied
      ? null
      : await this.prisma.walletHold.findUnique({
          where: { paymentId: view.id },
          select: { action: true },
        });
    const status: LegalFeeWalletStatus = applied
      ? 'paid'
      : payback
        ? 'refunded'
        : statusOf(view.status);
    return {
      id: view.id,
      method: 'wallet',
      requestId: view.targetId,
      stage,
      title: view.title,
      status,
      statusMessage: applied
        ? null
        : payback
          ? 'This fee could not be applied, so the price is going back to your wallet.'
          : (view.failureReason ?? view.statusMessage),
      priceKobo: view.priceKobo,
      requestStatus: request?.status ?? null,
      payment: view,
      createdAt: view.createdAt,
      paidAt: applied
        ? ((stage === 'service'
            ? request.servicePaidAt
            : request.consultationPaidAt
          )?.toISOString() ?? null)
        : null,
    };
  }
}

/** A payment that is not paid, as a legal fee status. */
function statusOf(status: PaymentView['status']): LegalFeeWalletStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}
