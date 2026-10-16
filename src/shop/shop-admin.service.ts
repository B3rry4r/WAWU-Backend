import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ShopFulfilment } from '../../generated/prisma/enums';
import {
  toAdminProduct,
  type AdminProductView,
} from '../common/types/shop.type';
import type { AdminListProductsDto, UpdateFulfilmentDto } from './dto/shop.dto';

/**
 * WAWU Shop from the admin dashboard, after the shop was retired (R-2,
 * OPS-08).
 *
 * The catalogue can be read but no longer written: creating or editing a
 * product answers 410 at the controller (`shop-retired.ts`). Products are
 * never deleted, because order lines point at them, and `toAdminProduct`
 * keeps reading them. The order queue and fulfilment stay: a paid order is
 * still a box somebody is owed.
 */
@Injectable()
export class ShopAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminListProductsDto): Promise<{
    items: AdminProductView[];
    total: number;
    /**
     * `currentPage`, not `page`: ResponseInterceptor reads `currentPage` off a
     * `{items, total}` return to work out `nextPage`.
     */
    currentPage: number;
    perPage: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(100, Math.max(1, query.perPage ?? 25));
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? {
            OR: [
              {
                name: { contains: query.search, mode: 'insensitive' as const },
              },
              {
                brand: { contains: query.search, mode: 'insensitive' as const },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      items: rows.map(toAdminProduct),
      total,
      currentPage: page,
      perPage,
    };
  }

  async get(id: string): Promise<AdminProductView> {
    const row = await this.prisma.product.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Product not found');
    return toAdminProduct(row);
  }

  /* ------------------------------------------------------------------ *
   * Orders — the manual logistics surface
   * ------------------------------------------------------------------ */

  /**
   * Paid orders, oldest first.
   *
   * Oldest first because this is a WORK QUEUE, not a feed: the order waiting
   * longest for dispatch is the one somebody should pack next. A pending order
   * was never paid for and is excluded — it is not owed anything.
   */
  async orders(query: {
    fulfilment?: ShopFulfilment;
    page?: number;
    perPage?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(100, Math.max(1, query.perPage ?? 25));
    const where: Prisma.ShopOrderWhereInput = {
      status: { in: ['paid', 'refunded'] },
      ...(query.fulfilment ? { fulfilment: query.fulfilment } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.shopOrder.findMany({
        where,
        include: { items: true },
        orderBy: { paidAt: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.shopOrder.count({ where }),
    ]);
    return { items: rows, total, currentPage: page, perPage };
  }

  /**
   * Move an order along.
   *
   * The timestamps are set HERE rather than trusted from the client, and only
   * on the transition into each state, so "dispatched at" means when somebody
   * actually pressed it.
   */
  async setFulfilment(id: string, dto: UpdateFulfilmentDto) {
    const existing = await this.prisma.shopOrder.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Order not found');
    if (existing.status !== 'paid') {
      throw new BadRequestException(
        'Only a paid order can be dispatched. This one has not been paid for.',
      );
    }
    return this.prisma.shopOrder.update({
      where: { id },
      data: {
        fulfilment: dto.fulfilment,
        ...(dto.trackingNote !== undefined
          ? { trackingNote: dto.trackingNote }
          : {}),
        ...(dto.fulfilment === 'dispatched' && !existing.dispatchedAt
          ? { dispatchedAt: new Date() }
          : {}),
        ...(dto.fulfilment === 'delivered' && !existing.deliveredAt
          ? { deliveredAt: new Date() }
          : {}),
      },
    });
  }
}
