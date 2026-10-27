import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** One notice as the dashboard reads it. */
export interface StoreAdminNoticeView {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: unknown;
  createdAt: string;
  readAt: string | null;
}

/** A page of notices, newest first. */
export interface StoreAdminNoticePageView {
  items: StoreAdminNoticeView[];
  unread: number;
}

/**
 * Notices for the owner about the store money (STORE-PAYOUT, STORE-CUT30): WAWU's
 * own account is short of what creators are owed, and a store's cut moved to 30%.
 * Written once per `noticeKey` (a unique key, so any number of servers writing
 * the same notice write one), listed by `GET /admin/store/notices`, marked read
 * by an admin. A notice names no person.
 */
@Injectable()
export class StoreAdminNoticeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes a notice unless one with this key exists. True when this call wrote
   * it (the caller that gets true is the one that tells the owner).
   */
  async once(
    n: {
      kind: string;
      noticeKey: string;
      title: string;
      body: string;
      data?: Prisma.InputJsonValue;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const { count } = await db.storeAdminNotice.createMany({
      data: [
        {
          kind: n.kind,
          noticeKey: n.noticeKey,
          title: n.title,
          body: n.body,
          ...(n.data === undefined ? {} : { data: n.data }),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async list(opts: {
    unreadOnly?: boolean;
    limit?: number;
  }): Promise<StoreAdminNoticePageView> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const [rows, unread] = await Promise.all([
      this.prisma.storeAdminNotice.findMany({
        where: opts.unreadOnly ? { readAt: null } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.prisma.storeAdminNotice.count({ where: { readAt: null } }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })),
      unread,
    };
  }

  /** Marks a notice read by an admin. Reading it again changes nothing. */
  async markRead(id: string, adminId: string): Promise<StoreAdminNoticeView> {
    const found = await this.prisma.storeAdminNotice.findUnique({
      where: { id },
    });
    if (found === null) throw new NotFoundException('That notice is gone.');
    const row =
      found.readAt === null
        ? await this.prisma.storeAdminNotice.update({
            where: { id },
            data: { readAt: new Date(), readByAdminId: adminId },
          })
        : found;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    };
  }
}
