import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { NotificationsResponse } from '../common/types';

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /notifications — registry.json response.shape:
   * "{unreadCount, items: PaginatedList<Notification>}". The `items` field
   * is itself the fully-wrapped PaginatedList shape (statusCode/message/
   * data/pagination) per common/types/notification.type.ts's
   * NotificationsResponse — ResponseInterceptor only auto-wraps a
   * *top-level* Paginated<T> return, so the nested pagination envelope is
   * built here explicitly.
   */
  async list(userWawuId: string, page: number, perPage: number): Promise<NotificationsResponse> {
    const skip = (page - 1) * perPage;

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userWawuId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
      }),
      this.prisma.notification.count({ where: { userWawuId } }),
      this.prisma.notification.count({ where: { userWawuId, read: false } }),
    ]);

    const nextPage = page * perPage < total ? page + 1 : null;

    return {
      unreadCount,
      items: {
        statusCode: 200,
        message: 'OK',
        data,
        pagination: { currentPage: page, nextPage, perPage, total },
      },
    };
  }

  /** POST /notifications/mark-all-read — response.shape: "void". */
  async markAllRead(userWawuId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userWawuId, read: false },
      data: { read: true },
    });
  }
}
