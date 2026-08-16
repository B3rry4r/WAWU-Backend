import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
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

    const [items, total] = await this.prisma.$transaction([
      this.prisma.savedItem.findMany({
        where: { userWawuId },
        orderBy: { savedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.savedItem.count({ where: { userWawuId } }),
    ]);

    return { items, currentPage: page, perPage, total };
  }
}
