import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma, StorePurchase } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AdminStorePurchaseQueryDto } from './store.dto';
import type {
  AdminStorePurchasePageView,
  AdminStorePurchaseView,
} from './store-view.type';

const CURSOR_PREFIX = 's1.';
const BAD_CURSOR = 'cursor is not one this list gave.';
const DEFAULT_LIMIT = 20;

function encodeCursor(row: Pick<StorePurchase, 'createdAt' | 'id'>): string {
  return (
    CURSOR_PREFIX +
    Buffer.from(
      JSON.stringify([row.createdAt.toISOString(), row.id]),
      'utf8',
    ).toString('base64url')
  );
}

function decodeCursor(raw: string): { at: Date; id: string } {
  if (!raw.startsWith(CURSOR_PREFIX)) throw new BadRequestException(BAD_CURSOR);
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url').toString(
        'utf8',
      ),
    );
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      const at = new Date(parsed[0]);
      if (!Number.isNaN(at.getTime())) return { at, id: parsed[1] };
    }
  } catch {
    // falls through
  }
  throw new BadRequestException(BAD_CURSOR);
}

/**
 * What the dashboard reads of the store purchases (task IAP-01): every purchase
 * and, separately, the refunds and revocations. Newest first, cursor paged. A
 * read only: nothing here changes a purchase.
 */
@Injectable()
export class StoreAdminService {
  constructor(private readonly prisma: PrismaService) {}

  purchases(
    q: AdminStorePurchaseQueryDto,
  ): Promise<AdminStorePurchasePageView> {
    return this.page(q, {});
  }

  /** Purchases the store paid back or withdrew (`refunded` and `revoked`). */
  refunds(q: AdminStorePurchaseQueryDto): Promise<AdminStorePurchasePageView> {
    return this.page(q, { status: { in: ['refunded', 'revoked'] } });
  }

  private async page(
    q: AdminStorePurchaseQueryDto,
    base: Prisma.StorePurchaseWhereInput,
  ): Promise<AdminStorePurchasePageView> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const where: Prisma.StorePurchaseWhereInput = {
      ...base,
      ...(q.platform ? { platform: q.platform } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status && base.status === undefined ? { status: q.status } : {}),
      ...(q.wawuUserId ? { wawuUserId: q.wawuUserId } : {}),
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.at } },
              { createdAt: after.at, id: { lt: after.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.storePurchase.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    return {
      items: items.map(adminPurchaseView),
      nextCursor:
        rows.length > limit ? encodeCursor(items[items.length - 1]) : null,
    };
  }
}

export function adminPurchaseView(r: StorePurchase): AdminStorePurchaseView {
  return {
    id: r.id,
    wawuUserId: r.wawuUserId,
    platform: r.platform,
    storeProductId: r.storeProductId,
    kind: r.kind,
    status: r.status,
    environment: r.environment,
    storeTransactionId: r.storeTransactionId,
    communityId: r.communityId,
    currency: r.currency,
    priceMicros: r.priceMicros === null ? null : r.priceMicros.toString(),
    referenceKobo: r.referenceKobo,
    storeFeeBps: r.storeFeeBps,
    netKobo: r.netKobo,
    creatorWawuUserId: r.creatorWawuUserId,
    creatorShareKobo: r.creatorShareKobo,
    purchasedAt: r.purchasedAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    endReason: r.endReason,
    takenBack:
      r.takenBack !== null &&
      typeof r.takenBack === 'object' &&
      !Array.isArray(r.takenBack)
        ? r.takenBack
        : null,
    flag: r.flag,
    flaggedAt: r.flaggedAt?.toISOString() ?? null,
  };
}
