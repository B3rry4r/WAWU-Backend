import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { FeedCardsService } from '../content-piece/feed-cards.service';
import { StorageService } from '../storage/storage.service';
import { decodeMeCursor, pageOf } from './me-cursor';
import type {
  LessonDoneState,
  LessonProgressView,
  PurchaseEntryView,
  PurchasePage,
} from './me-view.type';

/** How many handles a search may match before the title match alone is used. */
const HANDLE_MATCH_LIMIT = 200;

const LESSON_NOT_FOUND = 'Lesson not found.';

/** LIKE's own characters, as plain text (Postgres' default escape is a backslash). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * My purchases (M29) and course progress ("3 of 12 done"), task ME-10.
 *
 * WHAT A PURCHASE IS HERE. A completed `Purchase` row of type `content`: the
 * same row the content detail reads as "bought" (BACKEND_GAPS G-125 asks the
 * wallet unlock to write it too). Pending and failed charges are not
 * purchases. Tips are not either: they bought nothing.
 *
 * Blocks: a piece the caller bought stays on this list after either of them
 * blocks the other. It is the caller's own record of what they paid for, and
 * hiding it would hide money they spent. Default (agent), owner may override.
 */
@Injectable()
export class MePurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
    private readonly cards: FeedCardsService,
    private readonly storage: StorageService,
  ) {}

  private bought(me: string): Prisma.PurchaseWhereInput {
    return {
      buyerWawuId: me,
      type: 'content',
      status: 'completed',
      contentId: { not: null },
    };
  }

  /** M7's "My purchases 12". */
  count(me: string): Promise<number> {
    return this.prisma.purchase.count({ where: this.bought(me) });
  }

  /** GET /me/purchases. */
  async list(
    me: string,
    q: string | undefined,
    rawCursor: string | undefined,
    limit: number,
  ): Promise<PurchasePage> {
    const cursor = decodeMeCursor(rawCursor);
    const where: Prisma.PurchaseWhereInput = { ...this.bought(me) };
    const and: Prisma.PurchaseWhereInput[] = [];
    if (q) {
      // Prisma's `contains` passes % and _ to LIKE as wildcards, so they are
      // escaped here and match only as characters.
      const text = escapeLike(q);
      const handles = await this.prisma.userProfile.findMany({
        where: { handle: { contains: text, mode: 'insensitive' } },
        select: { wawuUserId: true },
        take: HANDLE_MATCH_LIMIT,
      });
      and.push({
        content: {
          OR: [
            { title: { contains: text, mode: 'insensitive' } },
            { creatorWawuId: { in: handles.map((h) => h.wawuUserId) } },
          ],
        },
      });
    }
    if (cursor) {
      and.push({
        OR: [
          { purchasedAt: { lt: cursor.at } },
          { purchasedAt: cursor.at, id: { lt: cursor.id } },
        ],
      });
    }
    if (and.length > 0) where.AND = and;

    const fetched = await this.prisma.purchase.findMany({
      where,
      orderBy: [{ purchasedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        purchasedAt: true,
        content: {
          select: {
            id: true,
            title: true,
            contentType: true,
            previewAssetUrl: true,
            creatorWawuId: true,
          },
        },
      },
    });
    const { rows, nextCursor } = pageOf(fetched, limit, (r) => ({
      at: r.purchasedAt,
      id: r.id,
    }));

    const pieces = rows.flatMap((r) => (r.content ? [r.content] : []));
    const courseIds = pieces
      .filter((p) => p.contentType === 'course')
      .map((p) => p.id);
    const [people, progress] = await Promise.all([
      this.cards.creatorsFor(pieces.map((p) => p.creatorWawuId)),
      this.progressFor(me, courseIds),
    ]);

    const items: PurchaseEntryView[] = [];
    for (const r of rows) {
      if (!r.content) continue;
      items.push({
        id: r.id,
        purchasedAt: r.purchasedAt.toISOString(),
        content: {
          id: r.content.id,
          title: r.content.title,
          contentType: r.content.contentType,
          thumbnailUrl: await this.storage.freshUrlFor(
            r.content.previewAssetUrl,
          ),
          creator: people.get(r.content.creatorWawuId)!,
        },
        lessons:
          r.content.contentType === 'course'
            ? (progress.get(r.content.id) ?? { total: 0, done: 0 })
            : null,
      });
    }
    return { items, nextCursor };
  }

  /** Lessons in each course piece, and how many of them `me` finished. Two grouped reads. */
  private async progressFor(
    me: string,
    contentIds: string[],
  ): Promise<Map<string, LessonProgressView>> {
    const out = new Map<string, LessonProgressView>();
    if (contentIds.length === 0) return out;
    const [totals, done] = await Promise.all([
      this.prisma.courseLesson.groupBy({
        by: ['contentId'],
        where: { contentId: { in: contentIds } },
        _count: { _all: true },
      }),
      this.prisma.courseLessonProgress.groupBy({
        by: ['contentId'],
        where: { userWawuId: me, contentId: { in: contentIds } },
        _count: { _all: true },
      }),
    ]);
    const doneBy = new Map(done.map((d) => [d.contentId, d._count._all]));
    for (const id of contentIds) {
      const total = totals.find((t) => t.contentId === id)?._count._all ?? 0;
      out.set(id, { total, done: Math.min(doneBy.get(id) ?? 0, total) });
    }
    return out;
  }

  /**
   * PUT (done) and DELETE (not done) /me/lessons/:lessonId/done.
   *
   * Only for a lesson the caller may open: their own piece, a paid piece they
   * have a completed purchase of, or a free piece that is live. Anything else
   * (no such lesson, a piece not live, one hidden by a block, a paid piece not
   * bought) is the same 404, so the route cannot be used to learn about a
   * piece. Idempotent both ways.
   */
  async setLessonDone(
    me: string,
    lessonId: string,
    done: boolean,
  ): Promise<LessonDoneState> {
    const lesson = await this.prisma.courseLesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        contentId: true,
        content: {
          select: { creatorWawuId: true, status: true, accessType: true },
        },
      },
    });
    if (!lesson) throw new NotFoundException(LESSON_NOT_FOUND);
    const piece = lesson.content;
    if (piece.creatorWawuId !== me) {
      await this.blocked.assertVisible(
        me,
        piece.creatorWawuId,
        LESSON_NOT_FOUND,
      );
      const purchase = await this.prisma.purchase.findFirst({
        where: { ...this.bought(me), contentId: lesson.contentId },
        select: { id: true },
      });
      const open =
        purchase !== null ||
        (piece.accessType === 'free' && piece.status === 'live');
      if (!open) throw new NotFoundException(LESSON_NOT_FOUND);
    }

    if (done) {
      await this.prisma.courseLessonProgress.createMany({
        data: [{ userWawuId: me, lessonId, contentId: lesson.contentId }],
        skipDuplicates: true,
      });
    } else {
      await this.prisma.courseLessonProgress.deleteMany({
        where: { userWawuId: me, lessonId },
      });
    }
    const progress = await this.progressFor(me, [lesson.contentId]);
    return {
      lessonId,
      contentId: lesson.contentId,
      done,
      lessons: progress.get(lesson.contentId)!,
    };
  }
}
