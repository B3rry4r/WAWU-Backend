import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { BlockedAccount } from '../common/types';

/**
 * BlockedAccount resource — registry.json "BlockedAccount". Both endpoints
 * are `roles: ["any"]` (any authenticated WAWU user), always scoped to the
 * caller's own userWawuId.
 *
 * The registry contract for this resource carries only GET (list) and
 * DELETE (unblock) — there is no POST/create endpoint anywhere in
 * registry.json for BlockedAccount, on either this resource or any other
 * (grepped the full registry). Creating a block is therefore out of scope
 * for this build agent, same pattern as SavedItem (create/remove owned by
 * ContentPiece) and MarketplaceSave-adjacent resources — a future resource
 * that owns the "block this account" action (e.g. from a profile screen)
 * would write directly into this same BlockedAccount table.
 */
@Injectable()
export class BlockedAccountService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /settings/privacy/blocked — scoped to the caller, newest-blocked first. */
  async list(userWawuId: string, page: number, perPage: number): Promise<Paginated<BlockedAccount>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.blockedAccount.findMany({
        where: { userWawuId },
        orderBy: { blockedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.blockedAccount.count({ where: { userWawuId } }),
    ]);

    return { items, currentPage: page, perPage, total };
  }

  /**
   * DELETE /settings/privacy/blocked/:id — unblock. `:id` is the
   * BlockedAccount row's own id (registry field, not the blocked user's
   * wawuId). Scoped by userWawuId in the same query so a caller can never
   * unblock (or discover the existence of) another user's block row —
   * a non-owned or non-existent id both 404 identically.
   */
  async remove(userWawuId: string, id: string): Promise<void> {
    const { count } = await this.prisma.blockedAccount.deleteMany({
      where: { id, userWawuId },
    });
    if (count === 0) {
      throw new NotFoundException('No blocked account found for that id');
    }
  }
}
