import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from '../direct-message/flutterwave-client.interface';
import { type ShopOrderView } from '../common/types/shop.type';
import type { VerifyShopOrderDto } from './dto/shop.dto';

/**
 * WAWU Shop, retired (R-2, OPS-08): what is left is a buyer's orders.
 *
 * Browsing, the cart and checkout were removed with the shop; their routes
 * answer 410 (`shop-retired.ts`). What stays:
 *
 * SETTLING A CHARGE OPENED BEFORE THE SHOP CLOSED. `verifyOrder` is called by
 * the buyer's browser and by the Flutterwave webhook. Refusing it would leave
 * somebody charged with no paid order, so it keeps working for an order that
 * already exists; it can no longer be reached for a new one, because nothing
 * creates one.
 *
 * SELLING THE LAST UNIT. Stock is claimed by a CONDITIONAL write that
 * re-checks availability in its own WHERE, inside the transaction that marks
 * the order paid, so two orders reaching for the last unit cannot both win.
 *
 * WHAT THE BUYER WAS SHOWN. Order lines carry the name and price snapshotted
 * at checkout, so a product edited later does not rewrite a past order.
 */
@Injectable()
export class ShopService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  /**
   * Confirm the money, claim the stock, empty the cart.
   *
   * Idempotent: the browser's verify and the webhook can settle the same
   * charge, and the second caller gets the order that exists rather than a
   * second deduction from stock.
   */
  async verifyOrder(
    buyerWawuId: string,
    orderId: string,
    dto: VerifyShopOrderDto,
  ): Promise<ShopOrderView> {
    const order = await this.prisma.shopOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.buyerWawuId !== buyerWawuId) {
      throw new ForbiddenException('This order is not yours.');
    }
    if (order.status === 'paid') return this.getOrder(buyerWawuId, orderId);
    if (order.status !== 'pending') {
      throw new ConflictException(`This order is already ${order.status}.`);
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const ok =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === order.flutterwaveTxRef &&
      result.amount >= order.totalNaira;

    if (!ok) {
      await this.prisma.shopOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'failed' },
      });
      throw new BadRequestException('Payment verification failed');
    }

    await this.prisma.$transaction(async (tx) => {
      // THE RACE. Each line claims its stock with the availability re-checked
      // in the WHERE, so Postgres serialises it. If two orders reach for the
      // last unit, exactly one update matches.
      for (const item of order.items) {
        const claimed = await tx.product.updateMany({
          where: { id: item.productId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (claimed.count === 0) {
          // The money is already taken at this point, so this is not a silent
          // failure: the whole transaction rolls back, the order stays
          // pending, and it surfaces as a 409 that support can act on. Seating
          // somebody for stock that is gone would be worse.
          throw new ConflictException(
            `${item.nameSnapshot} sold out while your payment was going through. You have not been charged for it. Contact support and we will put this right.`,
          );
        }
      }

      await tx.shopOrder.update({
        where: { id: order.id },
        data: {
          status: 'paid',
          paidAt: new Date(),
          flutterwaveTxId: result.transactionId,
        },
      });

      // The cart is emptied only once the order is genuinely paid. Clearing it
      // at checkout would lose somebody's basket when their card declined.
      await tx.cartItem.deleteMany({ where: { userWawuId: buyerWawuId } });
    });

    return this.getOrder(buyerWawuId, orderId);
  }

  /* ------------------------------------------------------------------ *
   * Orders
   * ------------------------------------------------------------------ */

  async myOrders(buyerWawuId: string): Promise<ShopOrderView[]> {
    const rows = await this.prisma.shopOrder.findMany({
      // A pending order is one that was never paid for. Showing it in order
      // history reads as "you bought this", which is false.
      where: { buyerWawuId, status: { not: 'pending' } },
      include: {
        items: { include: { product: { select: { images: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toWireOrder(r));
  }

  async getOrder(buyerWawuId: string, orderId: string): Promise<ShopOrderView> {
    const row = await this.prisma.shopOrder.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: { select: { images: true } } } },
      },
    });
    if (!row) throw new NotFoundException('Order not found');
    if (row.buyerWawuId !== buyerWawuId) {
      throw new ForbiddenException('This order is not yours.');
    }
    return this.toWireOrder(row);
  }

  /**
   * The narrowing that keeps `refundError` off the wire.
   *
   * It is an instruction to a WAWU operator — "Flutterwave refused this, do it
   * by hand" — and it is written for them, not for the customer whose order it
   * is attached to.
   */
  private toWireOrder(row: {
    id: string;
    status: ShopOrderView['status'];
    subtotalNaira: number;
    totalNaira: number;
    deliveryName: string;
    deliveryPhone: string;
    deliveryAddress: string;
    deliveryCity: string;
    deliveryState: string;
    deliveryNote: string | null;
    fulfilment: ShopOrderView['fulfilment'];
    dispatchedAt: Date | null;
    deliveredAt: Date | null;
    trackingNote: string | null;
    createdAt: Date;
    paidAt: Date | null;
    items: Array<{
      id: string;
      productId: string;
      nameSnapshot: string;
      priceNairaSnapshot: number;
      quantity: number;
      product?: { images: string[] } | null;
    }>;
  }): ShopOrderView {
    return {
      id: row.id,
      status: row.status,
      subtotalNaira: row.subtotalNaira,
      deliveryNaira: row.totalNaira - row.subtotalNaira,
      totalNaira: row.totalNaira,
      deliveryName: row.deliveryName,
      deliveryPhone: row.deliveryPhone,
      deliveryAddress: row.deliveryAddress,
      deliveryCity: row.deliveryCity,
      deliveryState: row.deliveryState,
      deliveryNote: row.deliveryNote,
      fulfilment: row.fulfilment,
      dispatchedAt: row.dispatchedAt,
      deliveredAt: row.deliveredAt,
      trackingNote: row.trackingNote,
      items: row.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        name: i.nameSnapshot,
        priceNaira: i.priceNairaSnapshot,
        quantity: i.quantity,
        imageUrl: i.product?.images[0] ?? null,
      })),
      createdAt: row.createdAt,
      paidAt: row.paidAt,
    };
  }
}
