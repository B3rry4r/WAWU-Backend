import { Injectable } from '@nestjs/common';
import type { StoreCredit } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { StoreError } from './store-error';
import {
  creditScopeFor,
  type CreditScope,
} from './question/store-question-rules';
import type { StoreCreditListView } from './store-view.type';

/**
 * Store credits (STORE-BUY-HUB round 3, R-101): what a fan paid for a ladder
 * purchase that could not be given. Worth the list price they paid; one credit
 * pays for ONE later piece, tip or pass at that price or less; never cash,
 * never expires. What it does not use stays a credit (STORE-BUY-HUB round 3).
 *
 * A credit has a scope (STORE-QUESTION, R-101 point 6). One with none pays for a
 * piece, a tip or a pass. A `question` credit, made when a paid question bought
 * in the store was not answered in time, pays for a paid question to any
 * creator at its price or less and for nothing else; the rest of one keeps its
 * scope. The two never pay for each other's kind.
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
        scope: r.scope === 'question' ? 'question' : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The open credit to pay a price with: the smallest one worth at least the
   * price (the oldest of those), so a large credit is not spent on a small
   * thing while a fitting one waits. Only a credit of the scope the purchase
   * `kind` needs counts (`creditScopeFor`). `store_credit_insufficient` when
   * none fits.
   */
  async pick(
    userId: string,
    listPriceKobo: number,
    kind = 'content',
  ): Promise<StoreCredit> {
    const scope: CreditScope = creditScopeFor(kind);
    const credit = await this.prisma.storeCredit.findFirst({
      where: {
        wawuUserId: userId,
        status: 'open',
        amountKobo: { gte: listPriceKobo },
        scope,
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
