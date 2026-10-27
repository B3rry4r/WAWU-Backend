import { Injectable } from '@nestjs/common';
import type { StoreCredit } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { StoreError } from './store-error';
import type { StoreCreditListView } from './store-view.type';

/**
 * Store credits (STORE-BUY-HUB round 3, R-101): what a fan paid for a ladder
 * purchase that could not be given. Worth the list price they paid; one credit
 * pays for ONE later piece, tip or pass at that price or less, whole (the rest
 * is not kept); never cash, never expires. The paid-question task reuses it.
 */
@Injectable()
export class StoreCreditService {
  constructor(private readonly prisma: PrismaService) {}

  /** The person's open credits, smallest first. */
  async list(userId: string): Promise<StoreCreditListView> {
    const rows = await this.prisma.storeCredit.findMany({
      where: { wawuUserId: userId, status: 'open' },
      orderBy: [{ amountKobo: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      credits: rows.map((r) => ({
        id: r.id,
        amountKobo: r.amountKobo,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The open credit to pay a price with: the smallest one worth at least the
   * price (the oldest of those), so a large credit is not spent on a small
   * thing while a fitting one waits. `store_credit_insufficient` when none fits.
   */
  async pick(userId: string, listPriceKobo: number): Promise<StoreCredit> {
    const credit = await this.prisma.storeCredit.findFirst({
      where: {
        wawuUserId: userId,
        status: 'open',
        amountKobo: { gte: listPriceKobo },
      },
      orderBy: [{ amountKobo: 'asc' }, { createdAt: 'asc' }],
    });
    if (credit === null)
      throw new StoreError(
        'store_credit_insufficient',
        'You have no store credit for that price.',
      );
    return credit;
  }
}
