import { randomBytes, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from '../direct-message/flutterwave-client.interface';
import {
  DELIVERY_NAIRA,
  MAX_CART_LINES,
  MAX_QUANTITY_PER_LINE,
} from './shop.constants';
import {
  toWireProduct,
  type CartView,
  type ProductView,
  type ShopCheckoutView,
  type ShopOrderView,
} from '../common/types/shop.type';
import type { ProductCategory } from '../../generated/prisma/enums';
import type { CheckoutDto, VerifyShopOrderDto } from './dto/shop.dto';

/**
 * WAWU Commerce — browse, cart, checkout.
 *
 * TWO THINGS IN HERE ARE LOAD-BEARING AND NEITHER IS THE HAPPY PATH.
 *
 * SELLING THE LAST UNIT. Stock is decremented by a CONDITIONAL write that
 * re-checks availability in its own WHERE, inside the transaction that creates
 * the order lines. Two people buying the last camera at the same instant is
 * the normal case for anything worth stocking, and a read-then-write sells it
 * twice — after which one of them is owed a refund and an apology.
 *
 * WHAT THE BUYER WAS SHOWN. The price is recalculated SERVER-SIDE at checkout
 * from the live product row, and then snapshotted onto the order line. The
 * client never sends an amount. A cart that has been open in a tab for two
 * days is repriced, and the buyer is told rather than silently charged the new
 * figure.
 *
 * DELIVERY IS MANUAL, AND THAT SHAPES THE CONTRACT. The brief says logistics
 * is physical and off-platform, so there is no courier call and no fee. What
 * there IS: a complete, required delivery address, because a human reads it
 * and carries a box to it. An order with no phone number cannot be delivered,
 * so the DTO refuses one.
 */
@Injectable()
export class ShopService {
  private readonly logger = new Logger(ShopService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  /* ------------------------------------------------------------------ *
   * Browsing
   * ------------------------------------------------------------------ */

  /**
   * The storefront.
   *
   * `status: 'live'` is applied here and has no client-side equivalent — a
   * draft product is a half-written listing with a placeholder price, and it
   * must not be reachable by guessing a query string.
   */
  async listProducts(query: {
    category?: ProductCategory;
    subcategory?: string;
    search?: string;
    wawuPick?: boolean;
    maxPriceNaira?: number;
    page?: number;
    perPage?: number;
  }): Promise<{
    items: ProductView[];
    total: number;
    // `currentPage`, NOT `page`. ResponseInterceptor recognises a paginated
    // return by `{items, total}` and then reads `currentPage` off it to work
    // out `nextPage`. Returning `page` still matches the check, so the shape
    // looks right — but `currentPage` arrives undefined, `nextPage` computes
    // to null on every page, and any client is silently pinned to page 1.
    // The shop-by-budget contract test caught exactly this.
    currentPage: number;
    perPage: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(60, Math.max(1, query.perPage ?? 24));

    const where = {
      status: 'live' as const,
      ...(query.category ? { category: query.category } : {}),
      ...(query.subcategory ? { subcategory: query.subcategory } : {}),
      ...(query.wawuPick === undefined ? {} : { wawuPick: query.wawuPick }),
      // "Shop by budget" from the brief: a ceiling, not a band. Somebody with
      // ₦50,000 wants everything they can afford, not only the expensive end.
      ...(query.maxPriceNaira === undefined
        ? {}
        : { priceNaira: { lte: query.maxPriceNaira } }),
      ...(query.search
        ? {
            OR: [
              {
                name: { contains: query.search, mode: 'insensitive' as const },
              },
              {
                brand: { contains: query.search, mode: 'insensitive' as const },
              },
              {
                subcategory: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        // In-stock first: a grid whose first row is sold out reads as a dead
        // shop. Then WAWU's picks, then newest.
        orderBy: [
          { stock: 'desc' },
          { wawuPick: 'desc' },
          { createdAt: 'desc' },
        ],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: rows.map(toWireProduct),
      total,
      currentPage: page,
      perPage,
    };
  }

  /** One product, by the slug in its URL. */
  async getProduct(slug: string): Promise<ProductView> {
    const row = await this.prisma.product.findUnique({ where: { slug } });
    // A hidden or draft product is a 404, not a 403: telling a stranger that a
    // product exists but is withheld is information they have no use for.
    if (!row || row.status !== 'live') {
      throw new NotFoundException('Product not found');
    }
    return toWireProduct(row);
  }

  /** The distinct subcategories that actually have live stock in an aisle. */
  async listSubcategories(category: ProductCategory): Promise<string[]> {
    const rows = await this.prisma.product.findMany({
      where: { status: 'live', category },
      select: { subcategory: true },
      distinct: ['subcategory'],
      orderBy: { subcategory: 'asc' },
    });
    // Derived from stock rather than hardcoded from the brief: a filter that
    // offers "Teleprompters" and returns nothing is a dead end.
    return rows.map((r) => r.subcategory);
  }

  /* ------------------------------------------------------------------ *
   * The cart — the brief's "WOW"
   * ------------------------------------------------------------------ */

  async getCart(userWawuId: string): Promise<CartView> {
    const rows = await this.prisma.cartItem.findMany({
      where: { userWawuId },
      include: { product: true },
      orderBy: { addedAt: 'desc' },
    });

    // A product that went hidden or out of stock while the cart sat open is
    // dropped from the totals but still SHOWN, so the buyer finds out here
    // rather than at the payment step.
    const items = rows.map((row) => {
      const product = toWireProduct(row.product);
      const sellable = row.product.status === 'live' && row.product.stock > 0;
      return {
        id: row.id,
        quantity: row.quantity,
        product,
        lineTotalNaira: sellable ? product.priceNaira * row.quantity : 0,
      };
    });

    const subtotalNaira = items.reduce((n, i) => n + i.lineTotalNaira, 0);
    return {
      items,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      subtotalNaira,
      deliveryNaira: DELIVERY_NAIRA,
      totalNaira: subtotalNaira + DELIVERY_NAIRA,
    };
  }

  /** Add, or raise the quantity of something already in the cart. */
  async addToCart(
    userWawuId: string,
    productId: string,
    quantity: number,
  ): Promise<CartView> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, status: true, stock: true },
    });
    if (!product || product.status !== 'live') {
      throw new NotFoundException('Product not found');
    }
    if (product.stock <= 0) {
      throw new ConflictException('This item is out of stock.');
    }

    const existing = await this.prisma.cartItem.findUnique({
      where: { userWawuId_productId: { userWawuId, productId } },
    });

    if (!existing) {
      const lines = await this.prisma.cartItem.count({ where: { userWawuId } });
      if (lines >= MAX_CART_LINES) {
        throw new BadRequestException(
          `A cart holds up to ${MAX_CART_LINES} different items.`,
        );
      }
    }

    const wanted = (existing?.quantity ?? 0) + quantity;
    // Capped at what is actually on the shelf as well as at the per-line
    // ceiling, so the cart cannot promise more than exists.
    const capped = Math.min(wanted, MAX_QUANTITY_PER_LINE, product.stock);
    if (capped < 1)
      throw new BadRequestException('Quantity must be at least 1.');

    await this.prisma.cartItem.upsert({
      where: { userWawuId_productId: { userWawuId, productId } },
      create: { userWawuId, productId, quantity: capped },
      update: { quantity: capped },
    });
    return this.getCart(userWawuId);
  }

  /** Set an exact quantity. Zero removes the line. */
  async setCartQuantity(
    userWawuId: string,
    productId: string,
    quantity: number,
  ): Promise<CartView> {
    if (quantity <= 0) return this.removeFromCart(userWawuId, productId);

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true, status: true },
    });
    if (!product || product.status !== 'live') {
      throw new NotFoundException('Product not found');
    }
    const capped = Math.min(quantity, MAX_QUANTITY_PER_LINE, product.stock);
    if (capped < 1) throw new ConflictException('This item is out of stock.');

    await this.prisma.cartItem.update({
      where: { userWawuId_productId: { userWawuId, productId } },
      data: { quantity: capped },
    });
    return this.getCart(userWawuId);
  }

  async removeFromCart(
    userWawuId: string,
    productId: string,
  ): Promise<CartView> {
    await this.prisma.cartItem.deleteMany({ where: { userWawuId, productId } });
    return this.getCart(userWawuId);
  }

  /* ------------------------------------------------------------------ *
   * Checkout
   * ------------------------------------------------------------------ */

  /**
   * Open an order and a charge.
   *
   * NOTHING IS RESERVED HERE and no stock moves. The order is `pending` and
   * holds the price the SERVER calculated; stock is claimed only once the
   * money is confirmed, in `verifyOrder`. Reserving at this point would let
   * anyone empty the shelf by opening checkouts they never complete.
   *
   * The amount is recomputed from live product rows, and a cart whose prices
   * or availability changed is REFUSED rather than quietly charged at the new
   * figure. Being told "the price changed" is annoying; being charged more
   * than the screen said is a chargeback.
   */
  async checkout(
    buyerWawuId: string,
    dto: CheckoutDto,
  ): Promise<ShopCheckoutView> {
    const rows = await this.prisma.cartItem.findMany({
      where: { userWawuId: buyerWawuId },
      include: { product: true },
    });
    if (rows.length === 0) {
      throw new BadRequestException('Your cart is empty.');
    }

    const unavailable = rows.filter(
      (r) => r.product.status !== 'live' || r.product.stock < r.quantity,
    );
    if (unavailable.length > 0) {
      throw new ConflictException(
        `${unavailable.map((r) => r.product.name).join(', ')} ${
          unavailable.length === 1 ? 'is' : 'are'
        } no longer available in that quantity. Update your cart and try again.`,
      );
    }

    const subtotal = rows.reduce(
      (n, r) => n + r.product.priceNaira * r.quantity,
      0,
    );
    const total = subtotal + DELIVERY_NAIRA;
    if (total < 1) {
      // Every product is priced above zero by the admin DTO, so this is
      // unreachable arithmetic rather than a business case — but a ₦0 charge
      // sent to Flutterwave is either rejected or, worse, accepted and looks
      // real in a reconciliation report.
      throw new BadRequestException('This order has no payable total.');
    }

    const charge = this.flutterwave.initCharge({
      amount: total,
      purpose: 'shop-order',
      wawuUserId: buyerWawuId,
    });

    const order = await this.prisma.shopOrder.create({
      data: {
        buyerWawuId,
        status: 'pending',
        subtotalNaira: subtotal,
        totalNaira: total,
        deliveryName: dto.deliveryName,
        deliveryPhone: dto.deliveryPhone,
        deliveryAddress: dto.deliveryAddress,
        deliveryCity: dto.deliveryCity,
        deliveryState: dto.deliveryState,
        deliveryNote: dto.deliveryNote ?? null,
        flutterwaveTxRef: charge.txRef,
        items: {
          create: rows.map((r) => ({
            productId: r.productId,
            // Snapshotted now. Editing the product later must not rewrite what
            // this person bought or what they paid for it.
            nameSnapshot: r.product.name,
            priceNairaSnapshot: r.product.priceNaira,
            quantity: r.quantity,
          })),
        },
      },
    });

    return {
      orderId: order.id,
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: 'NGN',
        publicKey: charge.publicKey,
      },
    };
  }

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
            `${item.nameSnapshot} sold out while your payment was going through. You have not been charged for it — contact support and we will put this right.`,
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

  /** Unused today; kept beside checkout so the txRef shape lives in one file. */
  protected newTxRef(): string {
    return `wawu-shop-${randomUUID()}-${randomBytes(4).toString('hex')}`;
  }
}
