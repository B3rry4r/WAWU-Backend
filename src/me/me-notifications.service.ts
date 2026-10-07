import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { FeedCardsService } from '../content-piece/feed-cards.service';
import {
  NOTIFICATION_CATEGORY,
  type NotificationKind,
} from '../notification/notification-event';
import { decodeMeCursor, pageOf } from './me-cursor';
import type {
  NotificationCategory,
  NotificationFeedItem,
  NotificationFeedPage,
  NotificationTargetView,
} from './me-view.type';

type FeedFilter = 'all' | 'money' | 'messages' | 'content';

function categoryOf(kind: string): NotificationCategory {
  return NOTIFICATION_CATEGORY[kind as NotificationKind] ?? 'other';
}

/** The kinds one chip shows. */
function kindsIn(filter: Exclude<FeedFilter, 'all'>): string[] {
  return Object.entries(NOTIFICATION_CATEGORY)
    .filter(([, category]) => category === filter)
    .map(([kind]) => kind);
}

/**
 * Notifications for the app (M31, M32), task ME-10: the caller's own rows,
 * newest first, by M31's chips, each with what opening it opens.
 *
 * GET /notifications (protected, read by the web) is unchanged; this reads
 * the same rows and the NotificationTarget written beside them since ME-10.
 *
 * TARGETS AS THEY ARE NOW. A target is resolved when the list is read: a
 * piece's or room's current title, a paid question's deadline. A target that
 * no longer exists is null, so the app falls back to routing by `kind`
 * rather than opening a 404.
 *
 * BLOCKS (SETTINGS-04). The notification stays (it is the reader's own
 * record: a sale is money they earned), but a person a block hides is not
 * shown: `actor` is null, and a target that is that person, or a paid
 * question with them, is null too.
 */
@Injectable()
export class MeNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
    private readonly cards: FeedCardsService,
  ) {}

  /** M7's "Notifications 3 new". */
  unreadCount(me: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userWawuId: me, read: false },
    });
  }

  /** GET /me/notifications. */
  async list(
    me: string,
    filter: FeedFilter,
    rawCursor: string | undefined,
    limit: number,
  ): Promise<NotificationFeedPage> {
    const cursor = decodeMeCursor(rawCursor);
    const where: Prisma.NotificationWhereInput = { userWawuId: me };
    if (filter !== 'all') where.kind = { in: kindsIn(filter) };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.at } },
        { createdAt: cursor.at, id: { lt: cursor.id } },
      ];
    }
    const [fetched, unreadCount, hiddenList] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: { target: true },
      }),
      this.unreadCount(me),
      this.blocked.hiddenFrom(me),
    ]);
    const { rows, nextCursor } = pageOf(fetched, limit, (r) => ({
      at: r.createdAt,
      id: r.id,
    }));
    const hidden = new Set(hiddenList);

    const idsOf = (kind: string) =>
      rows
        .filter((r) => r.target?.targetKind === kind)
        .map((r) => r.target!.targetId);
    const [pieces, questions, rooms, profiles] = await Promise.all([
      this.prisma.contentPiece.findMany({
        where: { id: { in: idsOf('content') } },
        select: { id: true, title: true },
      }),
      this.prisma.directMessage.findMany({
        where: { id: { in: idsOf('paid_question') } },
        select: { id: true, deadlineAt: true },
      }),
      this.prisma.community.findMany({
        where: { id: { in: idsOf('community') } },
        select: { id: true, name: true },
      }),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: idsOf('profile') } },
        select: { wawuUserId: true },
      }),
    ]);
    const pieceTitle = new Map(pieces.map((p) => [p.id, p.title]));
    const questionDeadline = new Map(
      questions.map((q) => [q.id, q.deadlineAt]),
    );
    const roomName = new Map(rooms.map((c) => [c.id, c.name]));
    const profileIds = new Set(profiles.map((p) => p.wawuUserId));

    const visibleActors = rows
      .map((r) => r.target?.actorWawuId)
      .filter((id): id is string => !!id && !hidden.has(id));
    const people = await this.cards.creatorsFor(visibleActors);

    const items: NotificationFeedItem[] = rows.map((r) => {
      const actorId = r.target?.actorWawuId ?? null;
      const actorHidden = actorId !== null && hidden.has(actorId);
      let target: NotificationTargetView | null = null;
      const t = r.target;
      if (t) {
        const view = (title: string | null, deadlineAt: Date | null) => ({
          kind: t.targetKind as NotificationTargetView['kind'],
          id: t.targetId,
          title,
          deadlineAt: deadlineAt ? deadlineAt.toISOString() : null,
        });
        if (t.targetKind === 'content' && pieceTitle.has(t.targetId)) {
          target = view(pieceTitle.get(t.targetId)!, null);
        } else if (
          t.targetKind === 'paid_question' &&
          questionDeadline.has(t.targetId) &&
          !actorHidden
        ) {
          target = view(null, questionDeadline.get(t.targetId)!);
        } else if (t.targetKind === 'community' && roomName.has(t.targetId)) {
          target = view(roomName.get(t.targetId)!, null);
        } else if (
          t.targetKind === 'profile' &&
          profileIds.has(t.targetId) &&
          !hidden.has(t.targetId)
        ) {
          target = view(null, null);
        }
      }
      return {
        id: r.id,
        kind: r.kind,
        category: categoryOf(r.kind),
        title: r.title,
        body: r.body,
        tone: r.tone,
        amountKobo: r.amount === null ? null : r.amount * 100,
        creditsCount: r.creditsCount,
        actionLabel: r.actionLabel,
        imageUrl: r.imageUrl,
        actionHref: r.actionHref,
        read: r.read,
        createdAt: r.createdAt.toISOString(),
        target,
        actor: actorId && !actorHidden ? (people.get(actorId) ?? null) : null,
      };
    });
    return { items, nextCursor, unreadCount };
  }
}
