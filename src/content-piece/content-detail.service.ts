import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { SetPreviewDto } from './dto/set-preview.dto';

/** The one wording for a piece that is missing, hidden or not the caller's. */
const NOT_FOUND = 'Content not found';

export interface FreePreview {
  /** Pages of a pdf anyone can read before buying; null when there is no page preview. */
  pages: number | null;
  /** Seconds of a video or audio file anyone can play before buying. */
  seconds: number | null;
  /** The first N lessons of a course, open to everyone. */
  lessons: number | null;
}

export interface DetailLesson {
  id: string;
  title: string;
  order: number;
  durationLabel: string | null;
  /** Inside the free preview (the first `freePreview.lessons` by order). */
  isFree: boolean;
}

export type CannotRateReason = 'own_content' | 'not_purchased';

export interface RatingState {
  /** Mean of every person's stars, one decimal, computed from the rating rows. Null before the first rating. */
  average: number | null;
  /** How many people have rated. */
  count: number;
  /** The caller's own stars (1 to 5), or null if they have not rated. */
  myRating: number | null;
  /** Whether the caller may rate (or change their rating) right now. */
  canRate: boolean;
  /** Why not, when `canRate` is false. */
  cannotRateReason: CannotRateReason | null;
}

export interface ContentDetail {
  contentId: string;
  contentType: string;
  /** Last time the creator changed the piece, or when it was made if never. */
  updatedAt: string;
  /** When the caller bought it (ISO), or null if they have not. */
  purchasedAt: string | null;
  /** People who have bought it (completed purchases). */
  buyerCount: number;
  /** Same people, for a paid course only; null for anything else, never a made-up number. */
  studentCount: number | null;
  freePreview: FreePreview;
  /** The course's lessons in order; empty for a piece that is not a course. */
  lessons: DetailLesson[];
  rating: RatingState;
}

/** One kind of piece takes one kind of preview. */
const PREVIEW_KEY = {
  pdf: 'freePages',
  video: 'freeSeconds',
  audio: 'freeSeconds',
  course: 'freeLessons',
} as const;

/**
 * Content detail: free previews, fair ratings and real counts (HOME-06).
 *
 * Everything here is a new route. Nothing is added to the rows GET /content
 * and GET /content/:id return, because those responses are the piece's row
 * itself and the web depends on their exact keys (protected route registry,
 * entry H-1); the new data lives in ContentRating and ContentDetail.
 */
@Injectable()
export class ContentDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
  ) {}

  /**
   * A piece the caller may not see answers exactly as one that does not
   * exist: the same 404 and the same words, in both block directions.
   */
  private async assertNotHidden(viewer: string, owner: string): Promise<void> {
    if (viewer === owner) return;
    if (await this.blocked.isBlockedEitherWay(viewer, owner)) {
      throw new NotFoundException(NOT_FOUND);
    }
  }

  private async completedPurchase(contentId: string, buyerWawuId: string) {
    return this.prisma.purchase.findFirst({
      where: {
        contentId,
        buyerWawuId,
        type: 'content',
        status: 'completed',
      },
      orderBy: { purchasedAt: 'asc' },
      select: { purchasedAt: true },
    });
  }

  private async ratingState(
    contentId: string,
    viewer: string,
    piece: { creatorWawuId: string; accessType: 'free' | 'paid' },
    bought: boolean,
  ): Promise<RatingState> {
    const [agg, mine] = await Promise.all([
      this.prisma.contentRating.aggregate({
        where: { contentId },
        _avg: { stars: true },
        _count: { _all: true },
      }),
      this.prisma.contentRating.findUnique({
        where: { userWawuId_contentId: { userWawuId: viewer, contentId } },
        select: { stars: true },
      }),
    ]);
    let cannotRateReason: CannotRateReason | null = null;
    if (piece.creatorWawuId === viewer) cannotRateReason = 'own_content';
    else if (piece.accessType === 'paid' && !bought)
      cannotRateReason = 'not_purchased';
    return {
      average:
        agg._avg.stars === null ? null : Math.round(agg._avg.stars * 10) / 10,
      count: agg._count._all,
      myRating: mine?.stars ?? null,
      canRate: cannotRateReason === null,
      cannotRateReason,
    };
  }

  /** GET /content/:id/detail. */
  async detail(contentId: string, viewer: string): Promise<ContentDetail> {
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!piece || piece.status === 'removed') {
      throw new NotFoundException(NOT_FOUND);
    }
    if (piece.status !== 'live' && piece.creatorWawuId !== viewer) {
      throw new NotFoundException(NOT_FOUND);
    }

    const purchase = await this.completedPurchase(contentId, viewer);
    // Same rule as GET /content/:id: somebody who already paid keeps their
    // copy after a block, so the detail of what they bought stays readable.
    if (!purchase) await this.assertNotHidden(viewer, piece.creatorWawuId);

    const [extra, lessons, buyers] = await Promise.all([
      this.prisma.contentDetail.findUnique({ where: { contentId } }),
      piece.contentType === 'course'
        ? this.prisma.courseLesson.findMany({
            where: { contentId },
            orderBy: { order: 'asc' },
          })
        : Promise.resolve([]),
      this.prisma.purchase.groupBy({
        by: ['buyerWawuId'],
        where: { contentId, type: 'content', status: 'completed' },
      }),
    ]);
    const freeLessons = extra?.freePreviewLessons ?? null;
    const buyerCount = buyers.length;

    return {
      contentId,
      contentType: piece.contentType,
      updatedAt: (extra?.contentUpdatedAt ?? piece.createdAt).toISOString(),
      purchasedAt: purchase ? purchase.purchasedAt.toISOString() : null,
      buyerCount,
      studentCount:
        piece.contentType === 'course' && piece.accessType === 'paid'
          ? buyerCount
          : null,
      freePreview: {
        pages: extra?.freePreviewPages ?? null,
        seconds: extra?.freePreviewSeconds ?? null,
        lessons: freeLessons,
      },
      lessons: lessons.map((l, i) => ({
        id: l.id,
        title: l.title,
        order: l.order,
        durationLabel: l.durationLabel,
        isFree: freeLessons !== null && i < freeLessons,
      })),
      rating: await this.ratingState(contentId, viewer, piece, !!purchase),
    };
  }

  /**
   * PUT /content/:id/rating, and the old POST /content/:id/rate behind it.
   *
   * The rules, all enforced here and never from anything the client sends
   * beyond the star count:
   *  - one rating per person per piece (unique key); rating again replaces it
   *  - a paid piece can only be rated by someone with a completed purchase
   *  - nobody rates their own piece
   *  - a piece the caller is blocked from, or that is not live, answers with
   *    the same 404 as a missing id
   *
   * Concurrency: the piece's row is locked (`FOR UPDATE`) before the rating is
   * written and the cache is recomputed, so two ratings at once run one after
   * the other and the later one sees the earlier one's row. The average is
   * always recomputed from the rows in the same transaction.
   */
  async rate(
    contentId: string,
    rater: string,
    stars: number,
  ): Promise<RatingState> {
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        status: true,
        creatorWawuId: true,
        accessType: true,
      },
    });
    if (!piece || piece.status !== 'live') {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertNotHidden(rater, piece.creatorWawuId);
    if (piece.creatorWawuId === rater) {
      throw new ForbiddenException('You cannot rate your own content.');
    }
    const purchase = await this.completedPurchase(contentId, rater);
    if (piece.accessType === 'paid' && !purchase) {
      throw new ForbiddenException('Only people who bought this can rate it.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ContentPiece" WHERE "id" = ${contentId} FOR UPDATE`,
      );
      await tx.contentRating.upsert({
        where: { userWawuId_contentId: { userWawuId: rater, contentId } },
        create: { userWawuId: rater, contentId, stars },
        update: { stars },
      });
      const agg = await tx.contentRating.aggregate({
        where: { contentId },
        _avg: { stars: true },
      });
      await tx.contentPiece.update({
        where: { id: contentId },
        data: {
          ratingPct:
            agg._avg.stars === null ? null : Math.round(agg._avg.stars * 20),
        },
      });
    });

    return this.ratingState(contentId, rater, piece, !!purchase);
  }

  /**
   * PUT /content/:id/preview: the creator says how much of their own piece is
   * free to look at. Anybody else gets the 404 a missing id gets.
   */
  async setPreview(
    contentId: string,
    creator: string,
    dto: SetPreviewDto,
  ): Promise<FreePreview> {
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (
      !piece ||
      piece.status === 'removed' ||
      piece.creatorWawuId !== creator
    ) {
      throw new NotFoundException(NOT_FOUND);
    }

    const given = {
      freePages: dto.freePages ?? null,
      freeSeconds: dto.freeSeconds ?? null,
      freeLessons: dto.freeLessons ?? null,
    };
    const wanted: string | undefined =
      PREVIEW_KEY[piece.contentType as keyof typeof PREVIEW_KEY];
    const anyGiven = Object.values(given).some((v) => v !== null);

    if (anyGiven) {
      if (!wanted) {
        throw new BadRequestException(
          'This kind of content has no free preview to set.',
        );
      }
      for (const [key, value] of Object.entries(given)) {
        if (value !== null && key !== wanted) {
          throw new BadRequestException(
            `Use ${wanted} for ${piece.contentType} content.`,
          );
        }
      }
      if (piece.accessType === 'free') {
        throw new BadRequestException(
          'Free content is open to everyone, so it has no preview to set.',
        );
      }
      if (
        given.freePages !== null &&
        piece.pageCount !== null &&
        given.freePages >= piece.pageCount
      ) {
        throw new BadRequestException(
          `The free preview must be fewer than the ${piece.pageCount} pages in the piece.`,
        );
      }
      if (given.freeLessons !== null) {
        const lessons = await this.prisma.courseLesson.count({
          where: { contentId },
        });
        if (given.freeLessons >= lessons) {
          throw new BadRequestException(
            `The free preview must be fewer than the ${lessons} lessons in the course.`,
          );
        }
      }
    }

    const row = await this.prisma.contentDetail.upsert({
      where: { contentId },
      create: {
        contentId,
        freePreviewPages: given.freePages,
        freePreviewSeconds: given.freeSeconds,
        freePreviewLessons: given.freeLessons,
        contentUpdatedAt: new Date(),
      },
      update: {
        freePreviewPages: given.freePages,
        freePreviewSeconds: given.freeSeconds,
        freePreviewLessons: given.freeLessons,
        contentUpdatedAt: new Date(),
      },
    });
    return {
      pages: row.freePreviewPages,
      seconds: row.freePreviewSeconds,
      lessons: row.freePreviewLessons,
    };
  }
}
