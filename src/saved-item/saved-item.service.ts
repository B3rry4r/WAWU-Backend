import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { suspendedIds } from '../common/suspension/user-suspension';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { SavedItem } from '../common/types';

@Injectable()
export class SavedItemService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /users/me/saved — registry.json "SavedItem".
   *
   * `kind` is an optional filter (content|guide|product) but this table
   * only ever holds content saves (see ListSavedItemsDto doc comment) —
   * `kind === 'guide' | 'product'` short-circuits to a genuine empty page
   * (matches conventions.md "empty = a genuine empty array response, not a
   * 404") rather than querying a column that doesn't exist.
   */
  async list(userWawuId: string, kind: string | undefined, page: number, perPage: number): Promise<Paginated<SavedItem>> {
    if (kind === 'guide' || kind === 'product') {
      return { items: [], currentPage: page, perPage, total: 0 };
    }

    // USER-SUSPEND (R-121, round 2 M1): a piece by a suspended creator is left off the list while the suspension is in
    // force (the save is kept; lifting brings it back). Nobody suspended: the query is the one it always was.
    const suspended = await suspendedIds(this.prisma, userWawuId);
    const where: Prisma.SavedItemWhereInput =
      suspended.length === 0
        ? { userWawuId }
        : { userWawuId, content: { creatorWawuId: { notIn: suspended } } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.savedItem.findMany({
        where,
        orderBy: { savedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.savedItem.count({ where }),
    ]);

    return { items, currentPage: page, perPage, total };
  }
}
