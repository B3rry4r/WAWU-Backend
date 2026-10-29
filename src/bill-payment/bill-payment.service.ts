import {
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { BillPayment } from '../../generated/prisma/client';
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
import {
  NO_DELIVERY,
  isPowerBill,
  mergeDelivery,
  readDelivery,
  type BillDelivery,
} from './bill-delivery';

/**
 * How long a bill may sit in `paid` — money taken, biller not yet called —
 * before it is treated as stuck and surfaced to an operator. Calling the
 * biller is a single synchronous request, so anything still `paid` after
 * this did not simply take a while: the process died between banking the
 * payment and making that call.
 */
const STUCK_AFTER_MINUTES = 15;

/**
 * How long a bill may sit in `processing` — the biller ACCEPTED the request,
 * but Flutterwave has not yet confirmed the top-up actually landed — before
 * an operator should look at it. Longer than `STUCK_AFTER_MINUTES` on
 * purpose: this is Flutterwave's own documented asynchronous settlement
 * window, not a dead process, so a short timer would flood the stuck queue
 * with rows that are still genuinely in flight.
 */
const PROCESSING_STUCK_AFTER_MINUTES = 30;

/**
 * BILLS-09: the buyer's status read asks Flutterwave about a `processing` bill only when the last look at the provider
 * (the purchase answer, the sweep, an operator's reconcile or an earlier read) is older than this. The app reads every
 * 10 seconds, so about every other read reaches the provider and two readers at once reach it once.
 */
const STATUS_READ_RECHECK_SECONDS = 20;

/**
 * BILLS-09 round 1: a delivered power bill that still has no token is asked about again by the buyer's status read (under the
 * same 20 second claim) for this long after it was delivered. A read of the provider, never a purchase.
 */
const TOKEN_REREAD_HOURS = 24;

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
 *
 * Nor is a biller's OWN "accepted" reply proof of delivery. Flutterwave's
 * Bills API documents step 3's call as asynchronous: the response confirms
 * the request was received, not that the top-up landed. A non-throwing call
 * moves the row to `processing`, and `reconcilePendingDeliveries()` (or an
 * operator's manual `reconcile()`) is what later turns that into `delivered`
 * or `failed` once Flutterwave actually confirms the outcome.
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
    // REFUSE BEFORE TAKING MONEY, not after.
    //
    // A bill is paid out of WAWU's own Flutterwave float, not the customer's
    // card. Card charges land in `ledger` and settle to `available` on
    // Flutterwave's cycle, so the float can be empty while money sits banked.
    // When that happened the customer was charged, the top-up failed with
    // "Insufficient funds in your wallet", and they were told a refund was
    // coming — money taken, nothing delivered, a manual refund owed.
    //
    // Checking here costs one request and turns that into a message before
    // anybody pays. A null reading means the balance could not be read, which
    // must NOT stop the shop: the existing post-charge failure path still
    // catches a genuine shortfall.
    const available = await this.bills.availableNgn();
    if (available !== null && available < dto.amount) {
      throw new ServiceUnavailableException(
        'Bill payments are briefly unavailable while we top up. Nothing has been charged. Please try again shortly.',
      );
    }

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
      return this.toBuyerResponse(record);
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
      return this.toBuyerResponse(settled ?? record);
    }

    try {
      const result = await this.bills.payBill({
        billerCode: record.billerCode,
        itemCode: record.itemCode,
        customerId: record.customerRef,
        amount: record.amount,
        reference: record.flutterwaveTxRef,
      });
      // Flutterwave's own documentation is explicit that this response only
      // means the request was ACCEPTED: delivery is asynchronous and "you
      // cannot rely on immediate confirmation." Recording this as `delivered`
      // right away is exactly the bug that let a customer be charged, see a
      // "delivered" receipt, and never actually receive the airtime when the
      // async step subsequently failed with nothing anywhere set up to catch
      // it. `processing` is the honest state: accepted, not yet confirmed.
      // BILLS-09: a prepaid electricity purchase may already carry its token (`recharge_token`); whatever it carries is
      // kept, and the purchase counts as the first look at the provider.
      const delivery = readDelivery(result);
      const processing = await this.prisma.billPayment.update({
        where: { id: record.id },
        data: {
          status: 'processing',
          providerReference: result.reference ?? result.tx_ref ?? null,
          providerStatus: result.code ?? null,
          fee: Math.round(Number(result.fee ?? 0)),
          providerCheckedAt: new Date(),
          ...(delivery.token ? { token: delivery.token } : {}),
          ...(delivery.units ? { units: delivery.units } : {}),
        },
      });
      return this.toBuyerResponse(processing);
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
      // The customer paid, so this is not a plain error: it is a refund owed.
      // The wording says what happens next in their terms — the old copy
      // ("our team will refund you") gave a reference and no timeframe, which
      // reads as a brush-off when you have just lost money.
      throw new BadRequestException(
        `Your payment went through but ${record.billerName} could not deliver it, so nothing was bought. ` +
          `You will be refunded in full within 3 working days. ` +
          `Quote ${failed.flutterwaveTxRef} if you need to chase it.`,
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
   * payment and calling the biller, the row stayed `paid` forever with
   * nothing anywhere looking for it. `processing` is included past its own,
   * longer cutoff for the same reason: a request the biller accepted but
   * never confirmed is just as stuck, only on a slower clock. `failed` is
   * included unconditionally because it means the same thing in money terms
   * — we hold their cash and they got nothing.
   */
  async listStuck() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
    const processingCutoff = new Date(
      Date.now() - PROCESSING_STUCK_AFTER_MINUTES * 60_000,
    );
    const rows = await this.prisma.billPayment.findMany({
      where: {
        OR: [
          { status: 'paid', createdAt: { lt: cutoff } },
          { status: 'processing', createdAt: { lt: processingCutoff } },
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
   *
   * `processing` is reconcilable for the same reason `paid` is: it is the
   * normal resting state of a bill whose acceptance Flutterwave has not yet
   * turned into a confirmed outcome, and an operator needs to be able to push
   * on it without waiting for the automated sweep's next pass.
   */
  async reconcile(billPaymentId: string, admin: AdminActor) {
    const record = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
    });
    if (!record) throw new NotFoundException('Bill payment not found.');
    if (
      record.status !== 'paid' &&
      record.status !== 'processing' &&
      record.status !== 'failed'
    ) {
      return {
        billPayment: this.toResponse(record),
        providerStatus: null,
        changed: false,
      };
    }

    const { providerStatus, delivery } = await this.readProviderAnswer(record);
    const settled = await this.settleFromProviderStatus(
      record,
      providerStatus,
      delivery,
    );

    if (settled.changed) {
      await this.audit.record(admin, {
        resource: 'bill_payment',
        resourceId: settled.record.id,
        subjectWawuId: settled.record.buyerWawuId,
        action: 'bill_reconciled',
        detail: {
          providerStatus,
          previousStatus: record.status,
          newStatus: settled.record.status,
        },
      });
    }
    return {
      billPayment: this.toResponse(settled.record),
      providerStatus,
      changed: settled.changed,
    };
  }

  /**
   * The write half of reconciliation, shared between an operator's manual
   * `reconcile()` call, the automated sweep below and the buyer's status read.
   * Pure state transition, no audit trail — callers that need one (a human
   * acting) record it themselves; the sweep (nothing human decided anything)
   * does not.
   *
   * BILLS-09: every provider answer also stamps `providerCheckedAt` and keeps a
   * token or units it carries (the first one kept is never replaced). The write
   * is conditional on the status the caller read: if the row moved meanwhile (a
   * sweep, an operator's refund, another reader) nothing is written over it and
   * the current row comes back unchanged, so two readers settle a bill once.
   */
  private async settleFromProviderStatus(
    record: BillPayment,
    providerStatus: 'successful' | 'failed' | 'unknown',
    delivery: BillDelivery = NO_DELIVERY,
  ): Promise<{ record: BillPayment; changed: boolean }> {
    const kept = {
      providerCheckedAt: new Date(),
      ...(delivery.token && !record.token ? { token: delivery.token } : {}),
      ...(delivery.units && !record.units ? { units: delivery.units } : {}),
    };

    let data: Record<string, unknown>;
    if (providerStatus === 'successful') {
      data = {
        ...kept,
        status: 'delivered',
        providerStatus,
        deliveredAt: record.deliveredAt ?? new Date(),
      };
    } else if (providerStatus === 'failed') {
      data = {
        ...kept,
        status: 'failed',
        providerStatus,
        failureReason:
          record.failureReason ?? 'The biller reported the payment as failed.',
      };
    } else {
      // Still in flight, or a shape we do not recognise. The status is left
      // alone rather than guessed at — the row stays visible in listStuck().
      data = kept;
    }

    const written = await this.prisma.billPayment.updateMany({
      where: { id: record.id, status: record.status },
      data,
    });
    const current = await this.prisma.billPayment.findUnique({
      where: { id: record.id },
    });
    return {
      record: current ?? record,
      changed: written.count > 0 && providerStatus !== 'unknown',
    };
  }

  /**
   * Automated reconciliation. Nobody is meant to have to open the stuck queue
   * for a bill to eventually settle: this asks Flutterwave about every
   * `processing`/`paid` row past its stuck cutoff and resolves what it can,
   * the same way an operator's manual reconcile does, minus the audit trail
   * (no human made a decision here). Rows Flutterwave still reports as in
   * flight, or whose answer we cannot fetch, are left alone for the next pass
   * or for an operator to reach through `listStuck()`.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'reconcile-pending-bills' })
  async reconcilePendingDeliveries(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
    const processingCutoff = new Date(
      Date.now() - PROCESSING_STUCK_AFTER_MINUTES * 60_000,
    );
    const rows = await this.prisma.billPayment.findMany({
      where: {
        OR: [
          { status: 'paid', createdAt: { lt: cutoff } },
          { status: 'processing', createdAt: { lt: processingCutoff } },
        ],
      },
      take: 200,
    });
    if (rows.length === 0) return;

    let settledCount = 0;
    for (const record of rows) {
      try {
        const { providerStatus, delivery } =
          await this.readProviderAnswer(record);
        const settled = await this.settleFromProviderStatus(
          record,
          providerStatus,
          delivery,
        );
        if (settled.changed) settledCount += 1;
      } catch (e) {
        // One bill's provider lookup failing must not stop the rest of the
        // sweep from running; it stays visible for the next pass either way.
        this.logger.warn(
          `Could not reconcile bill ${record.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (settledCount > 0) {
      this.logger.log(
        `Automatically reconciled ${settledCount} pending bill(s).`,
      );
    }
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
      throw new ConflictException(
        'This bill has already been recorded as refunded.',
      );
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

  /**
   * BILLS-09: `GET /bills/:id/status`, the buyer's own bill only (another
   * person's is "not found", the same as one that does not exist).
   *
   * Answers from the record. A `processing` bill whose last look at the
   * provider is older than 20 seconds is asked about once and settled the way
   * the sweep settles it. This is a read of the provider, never a purchase:
   * nothing here can call the biller, so a bill is never delivered twice.
   *
   * Safe when readers race: the right to ask is taken with one conditional
   * write on `providerCheckedAt`, so of any number of readers at once exactly
   * one asks the provider and the rest answer from the record; the settling
   * write is conditional on the status that was read, so the bill settles
   * once. Nothing is held across the provider call.
   */
  async statusOf(buyerWawuId: string, billPaymentId: string) {
    let record = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
    });
    if (!record || record.buyerWawuId !== buyerWawuId) {
      throw new NotFoundException('Bill payment not found.');
    }
    if (record.status === 'processing') {
      record = await this.askProviderOnce(record, 'settle');
    } else if (this.awaitsToken(record)) {
      record = await this.askProviderOnce(record, 'token');
    }
    return {
      id: record.id,
      status: record.status,
      token: record.token ?? null,
      units: record.units ?? null,
      providerReference: record.providerReference,
    };
  }

  /** A delivered power bill with no token, within 24 hours of its delivery (BILLS-09 round 1). */
  private awaitsToken(record: BillPayment): boolean {
    if (
      record.status !== 'delivered' ||
      record.token ||
      !isPowerBill(record.category)
    ) {
      return false;
    }
    const since = (record.deliveredAt ?? record.createdAt).getTime();
    return Date.now() - since < TOKEN_REREAD_HOURS * 3_600_000;
  }

  /**
   * What the provider says about a bill: its status and any token or units. The verbose answer carries the status; the token is
   * only in the plain shape, so a successful power bill with no token yet also reads that (a plain read that fails or has none
   * changes nothing). Throws only when the verbose read itself fails.
   */
  private async readProviderAnswer(
    record: BillPayment,
    force = false,
  ): Promise<{
    providerStatus: 'successful' | 'failed' | 'unknown';
    delivery: BillDelivery;
  }> {
    const answer = await this.bills.billStatus(record.flutterwaveTxRef);
    const providerStatus = readProviderStatus(answer);
    let delivery = readDelivery(answer);
    const wantsPlain =
      (providerStatus === 'successful' || force) &&
      isPowerBill(record.category) &&
      !record.token &&
      !delivery.token;
    if (wantsPlain) {
      try {
        const plain = await this.bills.billStatusPlain(record.flutterwaveTxRef);
        delivery = mergeDelivery(delivery, readDelivery(plain));
      } catch (e) {
        this.logger.warn(
          `Could not read the plain status of bill ${record.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { providerStatus, delivery };
  }

  private async askProviderOnce(
    record: BillPayment,
    mode: 'settle' | 'token',
  ): Promise<BillPayment> {
    const staleBefore = new Date(
      Date.now() - STATUS_READ_RECHECK_SECONDS * 1_000,
    );
    const claimed = await this.prisma.billPayment.updateMany({
      where: {
        id: record.id,
        status: record.status,
        ...(mode === 'token' ? { token: null } : {}),
        OR: [
          { providerCheckedAt: null },
          { providerCheckedAt: { lt: staleBefore } },
        ],
      },
      data: { providerCheckedAt: new Date() },
    });
    if (claimed.count === 0) {
      return (
        (await this.prisma.billPayment.findUnique({
          where: { id: record.id },
        })) ?? record
      );
    }

    try {
      const { providerStatus, delivery } = await this.readProviderAnswer(
        record,
        mode === 'token',
      );
      if (mode === 'token') {
        // A delivered bill stays delivered whatever the provider says now: only the token and units are kept.
        await this.prisma.billPayment.updateMany({
          where: { id: record.id, status: 'delivered', token: null },
          data: {
            ...(delivery.token ? { token: delivery.token } : {}),
            ...(delivery.units && !record.units
              ? { units: delivery.units }
              : {}),
          },
        });
        return (
          (await this.prisma.billPayment.findUnique({
            where: { id: record.id },
          })) ?? record
        );
      }
      const settled = await this.settleFromProviderStatus(
        record,
        providerStatus,
        delivery,
      );
      return settled.record;
    } catch (e) {
      // A provider that cannot be reached is not the buyer's problem and not a
      // failed bill: the record is answered and the next read tries again.
      this.logger.warn(
        `Could not read the status of bill ${record.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return (
        (await this.prisma.billPayment.findUnique({
          where: { id: record.id },
        })) ?? record
      );
    }
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
      items: items.map((i) => this.toBuyerResponse(i)),
      currentPage: page,
      perPage,
      total,
    };
  }

  /** What the buyer is served: the record plus the token and units, null when the bill has none (BILLS-09). */
  private toBuyerResponse(
    r: Parameters<BillPaymentService['toResponse']>[0] & {
      token?: string | null;
      units?: string | null;
    },
  ) {
    return {
      ...this.toResponse(r),
      token: r.token ?? null,
      units: r.units ?? null,
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
