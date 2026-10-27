import { Injectable } from '@nestjs/common';
import type { StorePlatform } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * What the stores charge in Nigeria for each list price (STORE-BUY-HUB, R-101
 * point 2), read from the active ladder products (`StoreProduct`, kind `buy`).
 * Shown beside the list price; the grant never reads it.
 */
@Injectable()
export class StorePriceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List price (whole naira) to store price (naira), for the active ladder
   * rows that have a store price. With a `platform`, that store's. Without
   * one, the higher of the two stores' (the price a person never pays more
   * than), so the figure shown is never too low.
   */
  async byListPrice(platform?: StorePlatform): Promise<Map<number, number>> {
    const rows = await this.prisma.storeProduct.findMany({
      where: {
        kind: 'buy',
        active: true,
        storePriceKobo: { not: null },
        referenceKobo: { not: null },
        ...(platform === undefined ? {} : { platform }),
      },
      select: { referenceKobo: true, storePriceKobo: true },
    });
    const out = new Map<number, number>();
    for (const r of rows) {
      const list = (r.referenceKobo as number) / 100;
      const store = (r.storePriceKobo as number) / 100;
      const seen = out.get(list);
      if (seen === undefined || store > seen) out.set(list, store);
    }
    return out;
  }
}
