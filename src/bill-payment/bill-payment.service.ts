import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AdminOpsAuditService,
  type AdminActor,
} from '../common/audit/admin-ops-audit.service';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import {
  FlutterwaveBillsClient,
  type BillCategory,
  type BillItem,
  type Biller,
} from './flutterwave-bills.client';
import type { InitBillDto, RecordRefundDto } from './dto/bill.dto';

/**
 * How long a bill may sit in `paid` — money taken, biller not yet paid —
 * before it is treated as stuck and surfaced to an operator. Delivery is a
 * single synchronous call, so anything still `paid` after this did not
 * simply take a while: the process died between banking the payment and
 * recording the outcome.
 */
const STUCK_AFTER_MINUTES = 15;

/**
 * WAWUPay.
 *
 * A bill is two separate money movements and the order matters:
 *   1. `init`   — record the intent, hand back a Flutterwave checkout config.
 *   2. payer completes checkout in Flutterwave's modal.
 *   3. `verify` — confirm that payment server-side, THEN pay the biller.
 *
 * Step 3 is deliberately not one atomic operation, because it cannot be: WAWU
 * can hold the customer's money and still have the biller reject the top-up.
 * That state is recorded as `paid` (money in, nothing delivered) rather than
 * being collapsed into a success or thrown away, so it can be reconciled or
 * refunded instead of quietly vanishing.
 */
@Injectable()
export class BillPaymentService {
  private readonly logger = new Logger(BillPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bills: FlutterwaveBillsClient,
    private readonly verifier: FlutterwaveCheckoutVerifier,
    private readonly audit: AdminOpsAuditService,
  ) {}

  listCategories(country = 'NG'): Promise<BillCategory[]> {
    return this.bills.listCategories(country);
  }

  /**
   * Billers in a category.
   *
   * `category` is the provider's CODE (AIRTIME, INTSERVICE, CABLEBILLS). If a
   * caller sends the display NAME instead, the provider answers "Invalid
   * category code" and the whole screen dead-ends — which is exactly what
   * happened to Internet Service, Cable Bill Payment, Mobile Data Service and
   * Utility Bills. Airtime alone survived, because its name equals its code.
   *
   * So a rejected value is looked up against the category list and retried
   * once. The lookup costs nothing on the happy path (it only runs after a
   * failure) and it means a client that sends a name gets billers rather than
   * a provider error it cannot act on.
   */
  async listBillers(category: string, country = 'NG'): Promise<Biller[]> {
    try {
      return await this.bills.listBillers(category, country);
    } catch (err) {
      const resolved = await this.resolveCategoryCode(category, country);
      // Only retry when the lookup found a DIFFERENT value; retrying the same
      // string would just repeat the same failure and double the latency.
      if (!resolved || resolved === category) throw err;
      return this.bills.listBillers(resolved, country);
    }
  }

  /** Matches a display name (or a differently-cased code) to a category code. */
  private async resolveCategoryCode(
    value: string,
    country: string,
  ): Promise<string | null> {
    let categories: BillCategory[];
    try {
      categories = await this.bills.listCategories(country);
    } catch {
      // The original error is the useful one; a failure to look up the code is
      // not worth replacing it with.
      return null;
    }
    const wanted = value.trim().toLowerCase();
    const hit = categories.find(
      (c) =>
        c.code?.toLowerCase() === wanted || c.name?.toLowerCase() === wanted,
    );
    return hit?.code ?? null;
  }

  listItems(billerCode: string): Promise<BillItem[]> {
    return this.bills.listItems(billerCode);
  }

  async validateCustomer(itemCode: string, customer: string) {
    const result = await this.bills.validateCustomer(itemCode, customer);
    return {
      customer,
      name: result.name ?? null,
      fee: result.fee ?? 0,
      minimum: result.minimum ?? 0,
      maximum: result.maximum ?? 0,
    };
  }

  /** Records the intent and returns what the client needs to open checkout. */
  async init(buyerWawuId: string, dto: InitBillDto) {
    const txRef = `wawu-bill-${randomUUID()}`;

    const record = await this.prisma.billPayment.create({
      data: {
        buyerWawuId,
        category: dto.category,
        billerCode: dto.billerCode,
        itemCode: dto.itemCode,
        billerName: dto.billerName,
        customerRef: dto.customerRef,
        amount: dto.amount,
        flutterwaveTxRef: txRef,
        status: 'pending',
      },
    });

    return {
      billPaymentId: record.id,
      flutterwaveConfig: {
        txRef,
        amount: dto.amount,
        currency: 'NGN',
        publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
      },
    };
  }

  /**
   * Confirms the customer's payment, then delivers the bill.
   *
   * Idempotent on purpose: a client that retries (double tap, flaky network)
   * must not be able to buy the same airtime twice. Anything already past
   * `pending` returns its current state instead of paying the biller again.
   */
  async verifyAndDeliver(
    buyerWawuId: string,
    billPaymentId: string,
    transactionId: string,
  ) {
    const record = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
    });
    if (!record || record.buyerWawuId !== buyerWawuId) {
      throw new NotFoundException('Bill payment not found.');
    }
    if (record.status !== 'pending') {
      return this.toResponse(record);
    }

    const verified = await this.verifier.verify({
      transactionId,
      expectedTxRef: record.flutterwaveTxRef,
      expectedAmount: record.amount,
    });

    // Money is in. From here the customer is owed either the bill or a refund,
    // so the payment is banked before the biller is called: if the process dies
    // mid-delivery we can still see that we hold their money.
    // Conditional flip. The `status !== 'pending'` read above is not a lock,
    // and since the Flutterwave webhook landed there are two callers that can
    // reach here for the same charge at once. Only the one that actually moves
    // the row out of `pending` may call the biller — delivering a bill twice
    // sends real money out twice.
    const claimed = await this.prisma.billPayment.updateMany({
      where: { id: record.id, status: 'pending' },
      data: { status: 'paid', flutterwaveTxId: verified.transactionId },
    });
    if (claimed.count === 0) {
      const settled = await this.prisma.billPayment.findUnique({
        where: { id: record.id },
      });
      return this.toResponse(settled ?? record);
    }

    try {
      const result = await this.bills.payBill({
        billerCode: record.billerCode,
        itemCode: record.itemCode,
        customerId: record.customerRef,
        amount: record.amount,
        reference: record.flutterwaveTxRef,
      });
      const delivered = await this.prisma.billPayment.update({
        where: { id: record.id },
        data: {
          status: 'delivered',
          providerReference: result.reference ?? result.tx_ref ?? null,
          providerStatus: result.code ?? null,
          fee: Math.round(Number(result.fee ?? 0)),
          deliveredAt: new Date(),
        },
      });
      return this.toResponse(delivered);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Delivery failed';
      this.logger.error(
        `Bill ${record.id} paid but not delivered (${record.billerName}): ${reason}`,
      );
      const failed = await this.prisma.billPayment.update({
        where: { id: record.id },
        data: { status: 'failed', failureReason: reason.slice(0, 500) },
      });
      // The customer paid, so this is not a plain error: it is a refund owed.
      throw new BadRequestException(
        `We took your payment but ${record.billerName} could not complete it. Reference ${failed.flutterwaveTxRef}. Our team will refund you.`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Operator recovery. Reached only through AdminAuthGuard + AdminRolesGuard
  // (superadmin/finance; the stuck queue also support) -- see the ops controller.
  // ---------------------------------------------------------------------

  /**
   * Everything the customer has paid for and not received.
   *
   * `paid` was a silent dead end: if the process died between banking the
   * payment and recording the biller's answer, the row stayed `paid` forever
   * with nothing anywhere looking for it. `failed` is included because it
   * means the same thing in money terms — we hold their cash and they got
   * nothing.
   */
  async listStuck() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
    const rows = await this.prisma.billPayment.findMany({
      where: {
        OR: [
          { status: 'paid', createdAt: { lt: cutoff } },
          { status: 'failed' },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map((r) => ({
      ...this.toResponse(r),
      buyerWawuId: r.buyerWawuId,
      flutterwaveTxRef: r.flutterwaveTxRef,
    }));
  }

  /**
   * Asks Flutterwave what actually happened to a stuck bill and records the
   * answer.
   *
   * This is a read, not a retry: re-sending the payment could top the
   * customer up twice. `billStatus` looks the bill up by the same reference
   * WAWU sent, so a delivery that succeeded and whose response was lost gets
   * recognised as delivered rather than refunded by mistake.
   */
  async reconcile(billPaymentId: string, admin: AdminActor) {
    const record = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
    });
    if (!record) throw new NotFoundException('Bill payment not found.');
    if (record.status !== 'paid' && record.status !== 'failed') {
      return { billPayment: this.toResponse(record), providerStatus: null, changed: false };
    }

    const result = await this.bills.billStatus(record.flutterwaveTxRef);
    const providerStatus = readProviderStatus(result);

    if (providerStatus === 'successful') {
      const delivered = await this.prisma.billPayment.update({
        where: { id: record.id },
        data: {
          status: 'delivered',
          providerStatus,
          deliveredAt: record.deliveredAt ?? new Date(),
        },
      });
      await this.audit.record(admin, {
        resource: 'bill_payment',
        resourceId: delivered.id,
        subjectWawuId: delivered.buyerWawuId,
        action: 'bill_reconciled',
        detail: { providerStatus, previousStatus: record.status, newStatus: 'delivered' },
      });
      return { billPayment: this.toResponse(delivered), providerStatus, changed: true };
    }

    if (providerStatus === 'failed') {
      const failed = await this.prisma.billPayment.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          providerStatus,
          failureReason:
            record.failureReason ?? 'The biller reported the payment as failed.',
        },
      });
      await this.audit.record(admin, {
        resource: 'bill_payment',
        resourceId: failed.id,
        subjectWawuId: failed.buyerWawuId,
        action: 'bill_reconciled',
        detail: { providerStatus, previousStatus: record.status, newStatus: 'failed' },
      });
      return { billPayment: this.toResponse(failed), providerStatus, changed: true };
    }

    // Still in flight, or a shape we do not recognise. Left alone rather than
    // guessed at — the row stays visible in listStuck(). No audit row: nothing
    // changed, and the trail records actions, not attempts.
    return { billPayment: this.toResponse(record), providerStatus, changed: false };
  }

  /**
   * Records a refund that has already been paid back to the customer.
   *
   * The status transition only. No money moves here and none can: there is no
   * Flutterwave refund adapter in this codebase, so this endpoint is a
   * bookkeeping entry for a transfer a human made, which is why the reference
   * of that transfer is required.
   */
  async recordRefund(
    billPaymentId: string,
    dto: RecordRefundDto,
    admin: AdminActor,
  ) {
    const record = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
    });
    if (!record) throw new NotFoundException('Bill payment not found.');
    if (record.status === 'refunded') {
      throw new ConflictException('This bill has already been recorded as refunded.');
    }
    if (record.status !== 'paid' && record.status !== 'failed') {
      throw new BadRequestException(
        `Only a bill WAWU was paid for and did not deliver can be refunded, not one that is ${record.status}.`,
      );
    }

    const refunded = await this.prisma.billPayment.update({
      where: { id: record.id },
      data: {
        status: 'refunded',
        refundReference: dto.refundReference,
        refundedAt: new Date(),
      },
    });
    this.logger.log(
      `Bill ${record.id} marked refunded against real-world reference ${dto.refundReference} by ${admin.email}.`,
    );
    // Recorded AFTER the transition and never allowed to fail it: the human
    // refund this row describes has already left WAWU's account.
    await this.audit.record(admin, {
      resource: 'bill_payment',
      resourceId: refunded.id,
      subjectWawuId: refunded.buyerWawuId,
      action: 'bill_refund_recorded',
      detail: {
        refundReference: dto.refundReference,
        amount: refunded.amount,
        fee: refunded.fee,
        previousStatus: record.status,
      },
    });
    return this.toResponse(refunded);
  }

  async listMine(buyerWawuId: string, page: number, perPage: number) {
    const where = { buyerWawuId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.billPayment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.billPayment.count({ where }),
    ]);
    return {
      items: items.map((i) => this.toResponse(i)),
      currentPage: page,
      perPage,
      total,
    };
  }

  private toResponse(r: {
    id: string;
    category: string;
    billerName: string;
    customerRef: string;
    amount: number;
    fee: number;
    status: string;
    providerReference: string | null;
    failureReason: string | null;
    createdAt: Date;
    deliveredAt: Date | null;
    refundReference: string | null;
    refundedAt: Date | null;
  }) {
    return {
      id: r.id,
      category: r.category,
      billerName: r.billerName,
      customerRef: r.customerRef,
      amount: r.amount,
      fee: r.fee,
      status: r.status,
      providerReference: r.providerReference,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      refundReference: r.refundReference,
      refundedAt: r.refundedAt?.toISOString() ?? null,
    };
  }
}

/**
 * Flutterwave's bill-status payload is loosely typed and has been both an
 * object and a single-element array. Anything not clearly successful or
 * failed is reported as unknown so the caller leaves the row alone.
 */
function readProviderStatus(
  payload: unknown,
): 'successful' | 'failed' | 'unknown' {
  const data = Array.isArray(payload) ? payload[0] : payload;
  if (!data || typeof data !== 'object') return 'unknown';
  const raw = (data as { status?: unknown }).status;
  const status = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (['successful', 'success', 'completed', 'delivered'].includes(status)) {
    return 'successful';
  }
  if (['failed', 'failure', 'reversed'].includes(status)) return 'failed';
  return 'unknown';
}
