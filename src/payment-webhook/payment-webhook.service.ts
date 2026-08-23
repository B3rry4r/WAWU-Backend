import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PurchaseService } from '../purchase/purchase.service';
import { ContentPieceService } from '../content-piece/content-piece.service';
import { CreditPurchaseService } from '../credit-purchase/credit-purchase.service';
import { CreatorSubscriptionService } from '../creator-subscription/creator-subscription.service';
import { DirectMessageService } from '../direct-message/direct-message.service';
import { DmRefundService } from '../direct-message/dm-refund.service';
import {
  CAC_TX_REF_PREFIX,
  ServiceApplicationService,
} from '../service-application/service-application.service';
import { BillPaymentService } from '../bill-payment/bill-payment.service';
import { HealthPlanService } from '../health-plan/health-plan.service';
import { LegalRequestsService } from '../legal/legal.service';

/**
 * The event Flutterwave fires when a checkout completes. Everything else
 * (transfer.completed, subscription cancellations, …) is recorded and ignored
 * — this backend settles exactly one kind of thing.
 */
const SETTLING_EVENT = 'charge.completed';
/**
 * Flutterwave confirming a refund it accepted earlier has now settled.
 *
 * This is the other half of paid-DM refunds: their refund API returns 200 for
 * "accepted", and the money reaching the payer's card is a separate,
 * later event. Without this the DM would sit at `submitted` forever and the
 * payer would never be told their money arrived, which is a quieter version
 * of the same failure as telling them too early.
 */
const REFUND_SETTLED_EVENT = 'refund.completed';

/** Terminal receipt states — a redelivery of one of these does nothing. */
const TERMINAL = new Set(['settled', 'rejected', 'ignored']);

export type WebhookOutcome =
  | 'settled'
  | 'rejected'
  | 'unmatched'
  | 'ignored'
  | 'duplicate'
  | 'in_progress';

export interface WebhookResult {
  outcome: WebhookOutcome;
  flow: string | null;
  detail: string | null;
}

interface ParsedDelivery {
  event: string;
  txRef: string;
  transactionId: string | null;
}

/** A settlement path we can hand a tx_ref to. */
export interface Dispatch {
  flow: string;
  settle: () => Promise<unknown>;
}

/**
 * Retryable failures. These must NOT be recorded terminally: the payment is
 * real and unsettled, and Flutterwave will redeliver if we answer non-2xx.
 * 502 is the checkout verifier's "could not reach Flutterwave"; 503/504 are
 * the same class from anywhere else.
 */
function isRetryable(e: unknown): boolean {
  if (e instanceof HttpException) {
    const status = e.getStatus();
    return status >= 500;
  }
  // Anything unrecognised (a DB blip, a bug) is treated as retryable so a
  // real charge is never quietly dropped.
  return true;
}

function messageOf(e: unknown): string {
  if (e instanceof HttpException) {
    const res = e.getResponse();
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object') {
      const m = (res as { message?: unknown }).message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m)) return m.join('; ');
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Flutterwave webhook receiver.
 *
 * Why this exists: every one of the money flows below used to be confirmed
 * ONLY by the browser calling a `/verify` endpoint after the checkout modal
 * closed. Close the tab, lose signal, or crash mid-redirect and the customer
 * is charged while this backend grants nothing — which is exactly what the
 * stuck `pending` purchases and orphaned PendingCharge rows in dev are.
 *
 * Two rules govern everything here:
 *
 * 1. **The payload is never evidence.** Its `amount`, `status` and `currency`
 *    are read for logging only. Settlement is delegated to the SAME `/verify`
 *    service methods the browser calls, and each of those re-verifies the
 *    transaction id against Flutterwave and compares the amount Flutterwave
 *    reports to the amount this server stored (`PendingCharge.expectedAmount`,
 *    `Purchase.amount`, `CreditPurchase.amount`, `BillPayment.amount`, …).
 *    A ₦1 payment cannot buy an ₦18,999 tier through this door either.
 *
 * 2. **Settlement happens at most once.** Two independent guards, because
 *    there are two different races:
 *    - webhook vs webhook (Flutterwave retries, or double-delivers): the
 *      unique `PaymentWebhookReceipt.deliveryKey` insert is the claim. The
 *      loser of that insert never reaches a settle path at all.
 *    - webhook vs browser `/verify` (they do not share the receipt table):
 *      the settle paths themselves are conditional writes — `updateMany`
 *      with the pre-state in the WHERE, or a claiming `deleteMany` on
 *      PendingCharge whose row count is the right to settle.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly purchases: PurchaseService,
    private readonly contentPieces: ContentPieceService,
    private readonly creditPurchases: CreditPurchaseService,
    private readonly subscriptions: CreatorSubscriptionService,
    private readonly directMessages: DirectMessageService,
    private readonly dmRefunds: DmRefundService,
    private readonly serviceApplications: ServiceApplicationService,
    private readonly bills: BillPaymentService,
    private readonly health: HealthPlanService,
    private readonly legal: LegalRequestsService,
  ) {}

  /** Narrow the untrusted body by hand — no DTO, because Flutterwave sends far
   * more fields than we model and the global `forbidNonWhitelisted` pipe would
   * reject a perfectly valid delivery. */
  private parse(body: unknown): ParsedDelivery | null {
    if (!body || typeof body !== 'object') return null;
    const root = body as Record<string, unknown>;
    const data = (root.data ?? {}) as Record<string, unknown>;

    // Note: Flutterwave also sends `event.type` ("CARD_TRANSACTION"), which is
    // the instrument, NOT the event name. Only `event` decides settlement.
    const event = typeof root.event === 'string' ? root.event : 'unknown';

    const txRefRaw = data.tx_ref ?? root.txRef ?? root.tx_ref;
    if (typeof txRefRaw !== 'string' || txRefRaw.length === 0) return null;

    const idRaw = data.id ?? root.id;
    const transactionId =
      typeof idRaw === 'string' || typeof idRaw === 'number'
        ? String(idRaw)
        : null;

    return { event, txRef: txRefRaw, transactionId };
  }

  async handle(body: unknown): Promise<WebhookResult> {
    const parsed = this.parse(body);
    if (!parsed) {
      // Nothing to key on, so nothing to claim and nothing to settle. Recorded
      // nowhere on purpose: an unkeyable body would need a synthetic id and
      // would let anyone with the hash fill the table.
      return { outcome: 'ignored', flow: null, detail: 'No tx_ref in payload' };
    }

    const { event, txRef, transactionId } = parsed;
    const deliveryKey = `${event}:${txRef}`;
    const payload = (body ?? {}) as object;

    // ---- The claim. Exactly one caller wins this insert. -------------------
    let receiptId: string;
    try {
      const created = await this.prisma.paymentWebhookReceipt.create({
        data: {
          deliveryKey,
          event,
          txRef,
          transactionId,
          status: 'received',
          payload,
        },
        select: { id: true },
      });
      receiptId = created.id;
    } catch {
      // Unique violation: this event+tx_ref has been delivered before.
      const existing = await this.prisma.paymentWebhookReceipt.findUnique({
        where: { deliveryKey },
        select: { id: true, status: true, flow: true },
      });
      if (!existing) throw new Error('Webhook receipt vanished mid-claim');

      if (TERMINAL.has(existing.status)) {
        return {
          outcome: 'duplicate',
          flow: existing.flow,
          detail: `Already ${existing.status}`,
        };
      }

      // Non-terminal: either another delivery is mid-flight, or a previous
      // attempt failed retryably. Only a `failed` row may be reclaimed, and
      // reclaiming is itself conditional so two retries cannot both take it.
      const reclaimed = await this.prisma.paymentWebhookReceipt.updateMany({
        where: { id: existing.id, status: 'failed' },
        data: { status: 'received', transactionId, detail: null },
      });
      if (reclaimed.count === 0) {
        return {
          outcome: 'in_progress',
          flow: existing.flow,
          detail: 'Another delivery of this charge is already being settled',
        };
      }
      receiptId = existing.id;
    }

    // ---- Settle. -----------------------------------------------------------
    try {
      const result = await this.settle(event, txRef, transactionId);
      await this.prisma.paymentWebhookReceipt.update({
        where: { id: receiptId },
        data: {
          status: result.outcome,
          flow: result.flow,
          detail: result.detail,
          settledAt: result.outcome === 'settled' ? new Date() : null,
        },
      });
      return result;
    } catch (e) {
      const detail = messageOf(e);
      if (isRetryable(e)) {
        // Leave it reclaimable and let the caller answer non-2xx so
        // Flutterwave redelivers. Never mark a real, unsettled charge done.
        await this.prisma.paymentWebhookReceipt.update({
          where: { id: receiptId },
          data: { status: 'failed', detail },
        });
        this.logger.error(`Webhook ${deliveryKey} failed (retryable): ${detail}`);
        throw e;
      }
      this.logger.warn(`Webhook ${deliveryKey} refused: ${detail}`);
      await this.prisma.paymentWebhookReceipt.update({
        where: { id: receiptId },
        data: { status: 'rejected', detail },
      });
      return { outcome: 'rejected', flow: null, detail };
    }
  }

  /**
   * The settlement router: resolve a tx_ref to its owning flow, hand that
   * flow its OWN verify method, and report the outcome.
   *
   * PUBLIC rather than private since 2026-08-22, and that is the only change
   * to this file. `src/admin/payments/` re-runs a stuck receipt through this
   * exact method instead of reimplementing settlement — the alternative was a
   * second payment engine in the admin tree, which is how two definitions of
   * "settled" get shipped. Not one line of the logic below moved, and the
   * exactly-once guarantee is unaffected: it does not live here. It lives in
   * the settle paths this method dispatches to (a claiming
   * `pendingCharge.deleteMany`, or an `updateMany` with the pre-state in the
   * WHERE), so a second call for an already-settled charge grants nothing no
   * matter who makes it. The receipt bookkeeping around this method belongs to
   * the caller — `handle()` above, and AdminPaymentsService.reverify().
   */
  /**
   * A refund Flutterwave has now actually paid out.
   *
   * Matched on the refund id we stored when they accepted it, falling back to
   * the DM's original tx_ref — Flutterwave's refund payloads have carried the
   * parent transaction's reference in `tx_ref` rather than the refund's own,
   * and a webhook that cannot find its row is a payer who is never told.
   *
   * Idempotent through DmRefundService.markSettled, which only writes from a
   * non-settled state and only notifies when that write happened, so a
   * redelivered webhook cannot announce the same refund twice.
   */
  private async settleRefund(
    txRef: string,
    transactionId: string | null,
  ): Promise<WebhookResult> {
    if (transactionId) {
      const byRefundId = await this.dmRefunds.settleFromWebhook(transactionId);
      if (byRefundId) {
        return { outcome: 'settled', flow: 'dm_refund', detail: null };
      }
    }

    const dm = await this.prisma.directMessage.findFirst({
      where: { flutterwaveTxRef: txRef, refundStatus: 'submitted' },
      select: { refundReference: true },
    });
    if (dm?.refundReference) {
      const settled = await this.dmRefunds.settleFromWebhook(
        dm.refundReference,
      );
      if (settled) {
        return { outcome: 'settled', flow: 'dm_refund', detail: null };
      }
    }

    // Not ours, or already settled by the executor's own poll. Neither is a
    // fault, and neither should retry.
    return {
      outcome: 'ignored',
      flow: null,
      detail: 'No paid-DM refund is awaiting settlement for this reference',
    };
  }

  async settle(
    event: string,
    txRef: string,
    transactionId: string | null,
  ): Promise<WebhookResult> {
    if (event === REFUND_SETTLED_EVENT) {
      return this.settleRefund(txRef, transactionId);
    }
    if (event !== SETTLING_EVENT) {
      return {
        outcome: 'ignored',
        flow: null,
        detail: `Event ${event} is not a settlement event`,
      };
    }
    if (!transactionId) {
      return {
        outcome: 'ignored',
        flow: null,
        detail: 'No transaction id to verify against Flutterwave',
      };
    }

    const dispatch = await this.resolve(txRef, transactionId);
    if (!dispatch) {
      // No record of this charge. Recorded rather than swallowed: it is either
      // a webhook that beat its own POST into the database, or a payment
      // belonging to a different WAWU service on the same Flutterwave account.
      this.logger.warn(`Webhook for unknown tx_ref ${txRef}`);
      return {
        outcome: 'unmatched',
        flow: null,
        detail: 'No money flow owns this tx_ref',
      };
    }

    try {
      await dispatch.settle();
    } catch (e) {
      if (isRetryable(e)) throw e;
      return { outcome: 'rejected', flow: dispatch.flow, detail: messageOf(e) };
    }
    return { outcome: 'settled', flow: dispatch.flow, detail: null };
  }

  /**
   * Map a tx_ref back to the flow that issued it, then hand that flow's OWN
   * verify method the same two values the browser would have posted. Nothing
   * about settlement is reimplemented here — this is a router, not a second
   * payment engine.
   *
   * PUBLIC rather than private since 2026-08-22, for the same reason `settle`
   * is: the admin reconciliation detail screen has to answer "why did this not
   * match, and would it match now?", and the only truthful answer is the one
   * this method computes. It is read-only — every branch below is a `findFirst`
   * / `findUnique` and the `settle` closure is not invoked by simply resolving.
   * `Dispatch` is exported alongside it so a caller can read `.flow` without
   * re-declaring the shape. AdminPaymentsService reads `.flow` and never calls
   * `.settle()`; settlement always goes through `settle()` above, which owns
   * the outcome vocabulary.
   */
  async resolve(
    txRef: string,
    transactionId: string,
  ): Promise<Dispatch | null> {
    const dto = { tx_ref: txRef, transaction_id: transactionId };

    // Credits.
    const creditPurchase = await this.prisma.creditPurchase.findFirst({
      where: { flutterwaveTxRef: txRef },
      select: { userWawuId: true },
    });
    if (creditPurchase) {
      return {
        flow: 'credit-purchase',
        settle: () =>
          this.creditPurchases.verifyPurchase(creditPurchase.userWawuId, dto),
      };
    }

    // Tips and paid content unlocks share the Purchase table.
    const purchase = await this.prisma.purchase.findFirst({
      where: { flutterwaveTxRef: txRef },
      select: { buyerWawuId: true, type: true, contentId: true },
    });
    if (purchase) {
      if (purchase.type === 'tip') {
        return {
          flow: 'tip',
          settle: () => this.purchases.verifyTip(purchase.buyerWawuId, dto),
        };
      }
      if (purchase.contentId) {
        return {
          flow: 'content-unlock',
          settle: () =>
            this.contentPieces.verifyUnlock(
              purchase.contentId as string,
              purchase.buyerWawuId,
              dto,
            ),
        };
      }
    }

    // Creator subscriptions (first subscribe and prorated upgrade) — keyed by
    // the tx_ref directly on PendingCharge.
    const pending = await this.prisma.pendingCharge.findUnique({
      where: { txRef },
      select: { kind: true, wawuUserId: true },
    });
    if (pending && (pending.kind === 'subscribe' || pending.kind === 'upgrade')) {
      return {
        flow: `subscription-${pending.kind}`,
        settle: () => this.subscriptions.verify(pending.wawuUserId, dto),
      };
    }

    // Paid DMs. Their PendingCharge row is keyed by the DM id (the verify
    // endpoint puts it in the URL), so the Flutterwave tx_ref lives in the
    // row's JSON context instead.
    const pendingDm = await this.prisma.pendingCharge.findFirst({
      where: { kind: 'dm', context: { path: ['txRef'], equals: txRef } },
      select: { txRef: true, wawuUserId: true },
    });
    if (pendingDm) {
      return {
        flow: 'dm',
        settle: () =>
          this.directMessages.sendVerify(
            pendingDm.wawuUserId,
            pendingDm.txRef,
            dto,
          ),
      };
    }

    // CAC registration — its tx_ref is `cac-<applicationId>`.
    if (txRef.startsWith(CAC_TX_REF_PREFIX)) {
      const application = await this.prisma.serviceApplication.findUnique({
        where: { id: txRef.slice(CAC_TX_REF_PREFIX.length) },
        select: { applicantWawuId: true },
      });
      if (application) {
        return {
          flow: 'cac',
          settle: () =>
            this.serviceApplications.verifyCac(application.applicantWawuId, dto),
        };
      }
    }

    // WAWUPay bills.
    const bill = await this.prisma.billPayment.findFirst({
      where: { flutterwaveTxRef: txRef },
      select: { id: true, buyerWawuId: true },
    });
    if (bill) {
      return {
        flow: 'bill-payment',
        settle: () =>
          this.bills.verifyAndDeliver(bill.buyerWawuId, bill.id, transactionId),
      };
    }

    // WAWUCare health plans.
    const healthSub = await this.prisma.healthSubscription.findFirst({
      where: { flutterwaveTxRef: txRef },
      select: { id: true, wawuUserId: true },
    });
    if (healthSub) {
      return {
        flow: 'health-subscription',
        settle: () =>
          this.health.verifyAndEnrol(
            healthSub.wawuUserId,
            healthSub.id,
            transactionId,
          ),
      };
    }

    // WAWU Legal — two separately-payable stages on the same request.
    const consultation = await this.prisma.legalRequest.findFirst({
      where: { consultationTxRef: txRef },
      select: { id: true, wawuUserId: true },
    });
    if (consultation) {
      return {
        flow: 'legal-consultation',
        settle: () =>
          this.legal.verifyConsultationPayment(
            consultation.wawuUserId,
            consultation.id,
            transactionId,
          ),
      };
    }

    const legalService = await this.prisma.legalRequest.findFirst({
      where: { serviceTxRef: txRef },
      select: { id: true, wawuUserId: true },
    });
    if (legalService) {
      return {
        flow: 'legal-service',
        settle: () =>
          this.legal.verifyServicePayment(
            legalService.wawuUserId,
            legalService.id,
            transactionId,
          ),
      };
    }

    return null;
  }
}
