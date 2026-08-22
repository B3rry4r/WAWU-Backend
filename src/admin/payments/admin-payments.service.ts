import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentWebhookService } from '../../payment-webhook/payment-webhook.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { PaymentWebhookReceiptModel } from '../../../generated/prisma/models';
import {
  REVERIFIABLE_RECEIPT_STATUSES,
  UNRESOLVED_RECEIPT_STATUSES,
  type AdminPaymentChargeView,
  type AdminPaymentDiagnosisView,
  type AdminPaymentReceiptDetailView,
  type AdminPaymentReceiptListItemView,
  type AdminPaymentReverifyView,
  type ReceiptStatus,
} from './admin-payment-view.type';
import type { AdminReceiptQueueQueryDto } from './dto/admin-receipt-queue-query.dto';

const MS_PER_HOUR = 3_600_000;

/**
 * The read side of `PaymentWebhookReceipt`, plus the one action an operator
 * legitimately has over a stuck charge.
 *
 * ── WHAT THIS SERVICE DELIBERATELY DOES NOT OFFER ────────────────────────
 * There is no "mark as paid", and there will not be one. Every settle path in
 * this backend compares what Flutterwave reports against what the SERVER
 * stored — `PendingCharge.expectedAmount`, `Purchase.amount`,
 * `CreditPurchase.amount` — because the client supplies the amount to the
 * inline SDK. That comparison is the only thing standing between a ₦1 payment
 * and an ₦18,999 Pro tier, and an admin button that writes the grant directly
 * is a door around it with a human's judgement as the lock.
 *
 * What an operator actually needs is narrower and safer: re-run the REAL
 * verification for a charge that got stuck. `reverify` does exactly that, by
 * calling `PaymentWebhookService.settle` — the same method the webhook itself
 * calls, which re-asks Flutterwave for the transaction and hands the answer to
 * the owning flow's own `/verify` logic. Nothing about settlement is
 * reimplemented here; this service owns the receipt bookkeeping around it and
 * nothing else.
 *
 * ── HOW EXACTLY-ONCE SURVIVES A RE-VERIFY ────────────────────────────────
 * Three independent layers, none of them new:
 *
 *  1. `settled` receipts are refused outright (409). A grant that already
 *     happened is never re-entered.
 *  2. The transition into settlement is a CLAIM, not a read-then-write: a
 *     conditional `updateMany` off the reverifiable statuses. Two operators
 *     double-clicking, or an operator racing a Flutterwave redelivery, produce
 *     exactly one claim; the loser gets a 409.
 *  3. The guarantee that actually holds if both of the above were removed: the
 *     settle paths themselves are conditional writes. A subscription's
 *     `PendingCharge` row is consumed by a claiming `deleteMany` whose row
 *     count IS the right to grant; purchases and credit purchases move status
 *     with an `updateMany` carrying the pre-state in the WHERE. So a second
 *     settlement of the same charge finds nothing left to claim and grants
 *     nothing — which is why re-verify can reuse the webhook's path rather
 *     than needing a safety net of its own.
 */
@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: PaymentWebhookService,
  ) {}

  /**
   * GET /admin/payments/receipts — the reconciliation screen, newest first.
   *
   * Unfiltered by default. `?status=unresolved` is the README's reconciliation
   * queue (`unmatched` | `rejected` | `failed`) as a single ordered, correctly
   * totalled page, rather than three fetches the dashboard would have to merge.
   */
  async listReceipts(
    query: AdminReceiptQueueQueryDto,
  ): Promise<Paginated<AdminPaymentReceiptListItemView>> {
    const where = {
      ...(query.status === 'unresolved'
        ? { status: { in: [...UNRESOLVED_RECEIPT_STATUSES] } }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.flow ? { flow: query.flow } : {}),
      // Contains, not equals: what an operator has in hand is usually a
      // reference pasted out of Flutterwave or a support ticket, often
      // truncated. Case-insensitive because the stored refs are mixed-case
      // (`mock-<uuid>`, `cac-<uuid>`) and nobody retypes those accurately.
      ...(query.txRef ? { txRef: { contains: query.txRef, mode: 'insensitive' as const } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.paymentWebhookReceipt.findMany({
        where,
        orderBy: { receivedAt: query.sort === 'oldest' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.paymentWebhookReceipt.count({ where }),
    ]);

    return {
      items: rows.map((row) => toListItem(row)),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /**
   * GET /admin/payments/receipts/:id — one receipt, with why it did not match.
   *
   * The stored `detail` says what was true when the delivery landed, which is
   * usually not the operator's question. A webhook that beat its own
   * `PendingCharge` insert into the database is marked `unmatched` forever even
   * though the charge appeared a second later, and nothing on the row will ever
   * say so. `diagnosis.currentlyOwnedBy` re-runs the SAME resolution the settle
   * path uses and answers it.
   */
  async receiptDetail(id: string): Promise<AdminPaymentReceiptDetailView> {
    const receipt = await this.prisma.paymentWebhookReceipt.findUnique({ where: { id } });
    if (!receipt) {
      throw new NotFoundException('Payment receipt not found.');
    }
    return this.toDetail(receipt);
  }

  /**
   * POST /admin/payments/receipts/:id/reverify — re-run the real verification.
   *
   * See the class comment for why this is the only write on this surface and
   * how it cannot double-grant.
   */
  async reverify(id: string): Promise<AdminPaymentReverifyView> {
    const receipt = await this.prisma.paymentWebhookReceipt.findUnique({ where: { id } });
    if (!receipt) {
      throw new NotFoundException('Payment receipt not found.');
    }

    const blocked = reverifyBlockedReasonFor(receipt.status as ReceiptStatus);
    if (blocked) {
      throw new ConflictException(blocked);
    }

    // ---- The claim. Exactly one caller wins this transition. ---------------
    // Conditional on the SET of reverifiable statuses, not on the status this
    // request happened to read a moment ago: two operators double-clicking, or
    // an operator racing a Flutterwave redelivery, must produce one settlement
    // attempt and one 409, never two attempts.
    //
    // `detail` is deliberately left alone rather than nulled (the webhook's own
    // reclaim nulls it). It is about to be overwritten by a fresh outcome
    // either way, and leaving it means a row stranded in `received` by a
    // process death still says why it was stuck.
    const claimed = await this.prisma.paymentWebhookReceipt.updateMany({
      where: { id, status: { in: [...REVERIFIABLE_RECEIPT_STATUSES] } },
      data: { status: 'received' },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'This receipt is already being settled — a redelivery or another operator got there first.',
      );
    }

    try {
      // The webhook's OWN settlement router, called with the values recorded on
      // the receipt. It re-asks Flutterwave for the transaction and hands the
      // answer to the owning flow's `/verify` logic. Nothing is reimplemented.
      const result = await this.webhooks.settle(
        receipt.event,
        receipt.txRef,
        receipt.transactionId,
      );

      const updated = await this.prisma.paymentWebhookReceipt.update({
        where: { id },
        data: {
          status: result.outcome,
          flow: result.flow,
          detail: result.detail,
          // Mirrors PaymentWebhookService.handle exactly. Clearing it on a
          // non-settled outcome is safe here because a `settled` receipt never
          // reaches this method — it is refused above — so there is no
          // settlement timestamp to erase.
          settledAt: result.outcome === 'settled' ? new Date() : null,
        },
      });

      return {
        outcome: result.outcome,
        flow: result.flow,
        detail: result.detail,
        granted: result.outcome === 'settled',
        receipt: await this.toDetail(updated),
      };
    } catch (e) {
      // Only retryable faults escape `settle` — it converts every refusal into
      // a `rejected` outcome itself. So this is Flutterwave unreachable, a
      // database blip, or a bug: the charge is real and still unsettled, and
      // the row must stay reclaimable rather than be recorded terminally.
      const detail = messageOf(e);
      await this.prisma.paymentWebhookReceipt.update({
        where: { id },
        data: { status: 'failed', detail },
      });
      this.logger.error(`Admin re-verify of receipt ${id} failed (retryable): ${detail}`);
      // Rethrown rather than reported as an outcome: the operator has to see
      // that nothing happened. HttpExceptions keep their own status (the
      // checkout verifier's 502 "could not reach Flutterwave" is more useful
      // than a flattened 500); anything else is a genuine 500 and is left to
      // AllExceptionsFilter.
      throw e;
    }
  }

  // ── views ────────────────────────────────────────────────────────────────

  private async toDetail(
    receipt: PaymentWebhookReceiptModel,
  ): Promise<AdminPaymentReceiptDetailView> {
    return {
      ...toListItem(receipt),
      charge: toChargeView(receipt.payload),
      diagnosis: await this.diagnose(receipt),
      payload: receipt.payload,
    };
  }

  /**
   * Why this receipt is where it is — computed fresh, never stored.
   *
   * `currentlyOwnedBy` comes from `PaymentWebhookService.resolve`, the same
   * tx_ref → flow resolution the settle path runs. Reusing it rather than
   * writing a second copy is the point: a diagnosis that disagreed with the
   * settle path about which flow owns a charge would be worse than no
   * diagnosis. `.settle()` on the returned dispatch is never called here —
   * resolving is a read.
   */
  private async diagnose(
    receipt: PaymentWebhookReceiptModel,
  ): Promise<AdminPaymentDiagnosisView> {
    const status = receipt.status as ReceiptStatus;
    const blocked = reverifyBlockedReasonFor(status);

    let currentlyOwnedBy: string | null = null;
    try {
      // `transactionId` is only ever passed through to the settle closures,
      // never used to look a flow up, so a receipt that arrived without one
      // still gets a truthful answer about ownership.
      const dispatch = await this.webhooks.resolve(receipt.txRef, receipt.transactionId ?? '');
      currentlyOwnedBy = dispatch?.flow ?? null;
    } catch (e) {
      // A diagnosis is a nice-to-have on a screen whose job is to render the
      // queue. A database hiccup while resolving must not 500 the detail page.
      this.logger.warn(`Could not resolve owner for tx_ref ${receipt.txRef}: ${messageOf(e)}`);
    }

    return {
      recordedReason: receipt.detail,
      currentlyOwnedBy,
      looksSettleableNow: currentlyOwnedBy !== null && status !== 'settled',
      reverifiable: blocked === null,
      reverifyBlockedReason: blocked,
    };
  }
}

/**
 * Why a re-verify would be refused, or null when it would be accepted.
 *
 * One function so the queue row's `reverifiable` flag, the detail page's
 * `diagnosis`, and the endpoint's own 409 can never disagree — a dashboard
 * that enables a button the API then refuses is a bug report waiting to be
 * filed.
 */
export function reverifyBlockedReasonFor(status: ReceiptStatus): string | null {
  if (status === 'settled') {
    return 'This charge has already been settled. Re-verifying cannot grant it a second time, and this endpoint will not pretend otherwise — open the creator or the purchase to see what was granted.';
  }
  if (status === 'received') {
    return 'A delivery of this charge is being settled right now. Wait for it to finish; the receipt will show the outcome.';
  }
  if (!REVERIFIABLE_RECEIPT_STATUSES.includes(status)) {
    return `Receipts in status "${status}" cannot be re-verified.`;
  }
  return null;
}

function toListItem(receipt: PaymentWebhookReceiptModel): AdminPaymentReceiptListItemView {
  const status = receipt.status as ReceiptStatus;
  return {
    id: receipt.id,
    deliveryKey: receipt.deliveryKey,
    event: receipt.event,
    txRef: receipt.txRef,
    transactionId: receipt.transactionId,
    status,
    flow: receipt.flow,
    detail: receipt.detail,
    receivedAt: receipt.receivedAt,
    settledAt: receipt.settledAt,
    waitingHours: Math.max(
      0,
      Math.floor((Date.now() - receipt.receivedAt.getTime()) / MS_PER_HOUR),
    ),
    reverifiable: reverifyBlockedReasonFor(status) === null,
  };
}

/**
 * Lifts the reconciliation fields out of the stored delivery.
 *
 * Every value here is for DISPLAY. `PaymentWebhookService` reads the payload's
 * amount and status for logging and refuses to treat any of it as evidence,
 * and neither does this surface: re-verify re-asks Flutterwave rather than
 * believing the row. Anything missing or the wrong type comes back null rather
 * than throwing — this is an untrusted third-party body that has been sitting
 * in a JSON column, not a DTO.
 */
export function toChargeView(payload: unknown): AdminPaymentChargeView {
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};
  const customer = isRecord(data.customer) ? data.customer : {};

  return {
    flwRef: asString(data.flw_ref),
    amount: asNumber(data.amount),
    chargedAmount: asNumber(data.charged_amount),
    currency: asString(data.currency),
    chargeStatus: asString(data.status),
    paymentType: asString(data.payment_type),
    customerEmail: asString(customer.email),
    chargeCreatedAt: asString(data.created_at),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Error-message extraction for the receipt's `detail` column. A formatting
 * helper, not settlement logic — it mirrors the private one in
 * payment-webhook.service.ts because a `detail` written by a re-verify should
 * read exactly like a `detail` written by a delivery.
 */
function messageOf(e: unknown): string {
  if (e instanceof HttpException) {
    const res = e.getResponse();
    if (typeof res === 'string') return res;
    if (isRecord(res)) {
      const m = res.message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m)) return m.join('; ');
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
