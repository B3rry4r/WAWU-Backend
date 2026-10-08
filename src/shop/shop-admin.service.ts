import { randomBytes } from 'crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ShopFulfilment } from '../../generated/prisma/enums';
import { slugify } from './shop.constants';
import {
  toAdminProduct,
  type AdminProductView,
} from '../common/types/shop.type';
import type {
  AdminListProductsDto,
  UpdateFulfilmentDto,
  UpsertProductDto,
} from './dto/shop.dto';

/**
 * Product and order management, from the admin dashboard.
 *
 * This is where WAWU Commerce stock comes from — the brief says products are
 * uploaded from the dashboard, so there is no seller-facing upload path and no
 * revenue split to snapshot. WAWU is the seller.
 *
 * ── THE TWO RULES THAT ARE NOT COSMETIC ────────────────────────────────────
 *
 * A LIVE PRODUCT NEEDS A PICTURE AND STOCK. Enforced on publish, not on save,
 * so a draft can be written before the photographs arrive. A live product with
 * no image is a grey box in a grid whose entire design is large imagery; a
 * live product with no stock is an advert for something nobody can buy.
 *
 * A "WAS" PRICE MUST ACTUALLY BE HIGHER. `compareAtNaira` that equals or
 * undercuts the real price renders as a discount that is not one. That is a
 * false claim about money, and it is refused rather than left to an admin to
 * notice.
 *
 * ── PRODUCTS ARE NEVER DELETED ─────────────────────────────────────────────
 * `hidden` pulls something off the storefront and keeps the row, because order
 * lines point at it. A deleted product is an old order nobody can explain.
 */
@Injectable()
export class ShopAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminListProductsDto): Promise<{
    items: AdminProductView[];
    total: number;
    /** `currentPage` — see the note in ShopService.listProducts. */
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

  async create(dto: UpsertProductDto): Promise<AdminProductView> {
    this.assertSellable(dto);
    const row = await this.prisma.product.create({
      data: {
        name: dto.name,
        // The random tail is not decoration: two products genuinely can share
        // a name, and a bare name-slug collides on the second one mid-save.
        slug: slugify(dto.name, randomBytes(3).toString('hex')),
        brand: dto.brand ?? null,
        description: dto.description,
        category: dto.category,
        subcategory: dto.subcategory.trim(),
        priceNaira: dto.priceNaira,
        compareAtNaira: dto.compareAtNaira ?? null,
        stock: dto.stock,
        images: dto.images,
        wawuVerified: dto.wawuVerified ?? false,
        wawuPick: dto.wawuPick ?? false,
        status: dto.status ?? 'draft',
      },
    });
    return toAdminProduct(row);
  }

  async update(id: string, dto: UpsertProductDto): Promise<AdminProductView> {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    this.assertSellable(dto);

    const row = await this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name,
        // The slug is NOT regenerated on rename. It is in a URL somebody may
        // have shared, and changing it silently breaks that link.
        brand: dto.brand ?? null,
        description: dto.description,
        category: dto.category,
        subcategory: dto.subcategory.trim(),
        priceNaira: dto.priceNaira,
        compareAtNaira: dto.compareAtNaira ?? null,
        stock: dto.stock,
        images: dto.images,
        wawuVerified: dto.wawuVerified ?? false,
        wawuPick: dto.wawuPick ?? false,
        ...(dto.status ? { status: dto.status } : {}),
      },
    });
    return toAdminProduct(row);
  }

  /**
   * What "live" costs you.
   *
   * A draft may be as incomplete as the admin likes — that is what a draft is
   * for. The moment it goes on the storefront it has to be something a
   * stranger can actually buy.
   */
  private assertSellable(dto: UpsertProductDto): void {
    if (
      dto.compareAtNaira !== undefined &&
      dto.compareAtNaira !== null &&
      dto.compareAtNaira <= dto.priceNaira
    ) {
      throw new BadRequestException(
        'The "was" price has to be higher than the price you are selling at, or it reads as a discount that is not one.',
      );
    }
    if (dto.status !== 'live') return;

    if (dto.images.length === 0) {
      throw new BadRequestException(
        'A product needs at least one image before it can go on the storefront.',
      );
    }
    if (dto.stock <= 0) {
      throw new BadRequestException(
        'A product with no stock cannot go live — shoppers would see something they cannot buy. Save it as a draft, or add stock.',
      );
    }
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
    refuseUnreadableOrdersQuery(query.fulfilment, page, perPage);
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

/** Every fulfilment state; TypeScript checks the keys against the enum. */
const SHOP_FULFILMENTS: Record<ShopFulfilment, true> = {
  awaiting_dispatch: true,
  dispatched: true,
  delivered: true,
};

/**
 * FIX-17. `GET /admin/shop/orders` reads `fulfilment`, `page` and `perPage`
 * as raw strings, and four of their values made Prisma refuse the query
 * (500): a `fulfilment` outside the enum (or sent twice), a `page` or
 * `perPage` that is not a number (or sent twice), and a `page` whose offset
 * passes what Postgres can count (a 64-bit integer; `page=Infinity`,
 * `page=1e18`). Each is now a 400 naming the field, before the query.
 *
 * Every value that answered 200 still does, read the way it always was: an
 * empty `fulfilment` filters nothing, and `page=0`, `page=1.5` or
 * `perPage=1000` are clamped above as before.
 */
function refuseUnreadableOrdersQuery(
  fulfilment: unknown,
  page: number,
  perPage: number,
): void {
  const states = Object.keys(SHOP_FULFILMENTS);
  if (
    fulfilment &&
    !(typeof fulfilment === 'string' && states.includes(fulfilment))
  ) {
    throw new BadRequestException(
      `fulfilment must be one of the following values: ${states.join(', ')}`,
    );
  }
  if (Number.isNaN(page))
    throw new BadRequestException('page must be a number');
  if (Number.isNaN(perPage))
    throw new BadRequestException('perPage must be a number');
  if (!((page - 1) * perPage < 2 ** 63))
    throw new BadRequestException('page must be a smaller number');
}
