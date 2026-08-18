import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import {
  FlutterwaveBillsClient,
  type BillCategory,
  type BillItem,
  type Biller,
} from './flutterwave-bills.client';
import type { InitBillDto } from './dto/bill.dto';

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
  ) {}

  listCategories(country = 'NG'): Promise<BillCategory[]> {
    return this.bills.listCategories(country);
  }

  listBillers(category: string, country = 'NG'): Promise<Biller[]> {
    return this.bills.listBillers(category, country);
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
    const paid = await this.prisma.billPayment.update({
      where: { id: record.id },
      data: { status: 'paid', flutterwaveTxId: verified.transactionId },
    });

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
    };
  }
}
