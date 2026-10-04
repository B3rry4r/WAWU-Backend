import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { ContentPieceResponse } from '../common/types/content-piece.type';
import { ContentPieceService } from './content-piece.service';
import type { ContentSort } from './ranking';

/** What the viewer has done with, and to, one piece. */
export interface ViewerContentState {
  likedByMe: boolean;
  savedByMe: boolean;
  /** The viewer follows the piece's creator. */
  followsCreator: boolean;
}

/**
 * One card of GET /feed: the same piece GET /content serves, plus what only
 * this viewer's session can know. The extra keys live here, never on
 * GET /content or GET /content/:id, whose shapes the web depends on
 * (protected route registry, entry H-1).
 */
export type FeedItem = ContentPieceResponse &
  ViewerContentState & { shares: number };

export interface LikeState {
  likes: number;
  likedByMe: boolean;
}

export interface ViewState {
  views: number;
  /** False when this open was not counted: the owner's own, or a repeat today. */
  counted: boolean;
}

export interface ShareState {
  shares: number;
  /** False when this share was not counted: a repeat by the same person today. */
  counted: boolean;
}

export interface ContentEngagement extends ViewerContentState {
  likes: number;
  views: number;
  shares: number;
  commentCount: number;
}

export interface FollowingCount {
  count: number;
}

/** The UTC calendar day, as the date the once-a-day keys are on. */
function utcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Likes, views, shares and the per-viewer flags on content (HOME-04).
 *
 * Counters stay where every existing response and the ranking already read
 * them (`ContentPiece.likes`, `ContentPiece.views`). Each one moves in the
 * same transaction as the row that justifies it, and only when that row was
 * really created or removed, so a repeat request can never count twice.
 * Shares have no counter column (a new column would widen every live content
 * response); the count is the number of rows.
 */
@Injectable()
export class ContentEngagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentPieceService,
  ) {}

  /** A piece anyone may act on: it exists and is live. */
  private async requireLive(contentId: string) {
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { id: true, status: true, creatorWawuId: true },
    });
    if (!piece || piece.status !== 'live') {
      throw new NotFoundException('Content not found');
    }
    return piece;
  }

  private async counters(contentId: string) {
    return this.prisma.contentPiece.findUniqueOrThrow({
      where: { id: contentId },
      select: { likes: true, views: true, commentCount: true },
    });
  }

  /**
   * POST and DELETE /content/:id/like. Both idempotent. `createMany` with
   * `skipDuplicates` is `ON CONFLICT DO NOTHING` on the unique (user, piece)
   * key, so two simultaneous likes from one person race on the key and only
   * one row, and so one increment, can exist.
   */
  async setLiked(
    contentId: string,
    userWawuId: string,
    liked: boolean,
  ): Promise<LikeState> {
    if (liked) {
      await this.requireLive(contentId);
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.contentLike.createMany({
          data: [{ userWawuId, contentId }],
          skipDuplicates: true,
        });
        if (count > 0) {
          await tx.contentPiece.update({
            where: { id: contentId },
            data: { likes: { increment: 1 } },
          });
        }
      });
    } else {
      const exists = await this.prisma.contentPiece.findUnique({
        where: { id: contentId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Content not found');
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.contentLike.deleteMany({
          where: { userWawuId, contentId },
        });
        if (count > 0) {
          // Never below zero: rows seeded or imported before this table
          // existed carry a counter this table cannot account for.
          await tx.contentPiece.updateMany({
            where: { id: contentId, likes: { gt: 0 } },
            data: { likes: { decrement: 1 } },
          });
        }
      });
    }
    const { likes } = await this.counters(contentId);
    return { likes, likedByMe: liked };
  }

  /**
   * POST /content/:id/view: the app calls it when a piece is opened. One
   * counted view per person per piece per UTC day, and never the owner's own
   * (reloading your own piece is not somebody looking at it). Same rule as
   * ProfileView, for the same reason: the number must not be easy to inflate.
   */
  async recordView(
    contentId: string,
    viewerWawuId: string,
  ): Promise<ViewState> {
    const piece = await this.requireLive(contentId);
    let counted = false;
    if (piece.creatorWawuId !== viewerWawuId) {
      counted = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.contentView.createMany({
          data: [{ contentId, viewerWawuId, viewedOn: utcDay() }],
          skipDuplicates: true,
        });
        if (count > 0) {
          await tx.contentPiece.update({
            where: { id: contentId },
            data: { views: { increment: 1 } },
          });
        }
        return count > 0;
      });
    }
    const { views } = await this.counters(contentId);
    return { views, counted };
  }

  /**
   * POST /content/:id/share: the app calls it when the person completes the
   * share sheet. One counted share per person per piece per UTC day. The
   * owner sharing their own work counts: that is how work gets shared.
   */
  async recordShare(
    contentId: string,
    sharerWawuId: string,
  ): Promise<ShareState> {
    await this.requireLive(contentId);
    const { count } = await this.prisma.contentShare.createMany({
      data: [{ contentId, sharerWawuId, sharedOn: utcDay() }],
      skipDuplicates: true,
    });
    const shares = await this.prisma.contentShare.count({
      where: { contentId },
    });
    return { shares, counted: count > 0 };
  }

  /** Viewer flags and share counts for a batch of pieces, in four reads. */
  private async stateFor(
    viewerWawuId: string,
    pieces: Array<{ id: string; creatorWawuId: string }>,
  ) {
    const ids = pieces.map((p) => p.id);
    const creators = [...new Set(pieces.map((p) => p.creatorWawuId))];
    const [liked, saved, follows, shareCounts] = await Promise.all([
      this.prisma.contentLike.findMany({
        where: { userWawuId: viewerWawuId, contentId: { in: ids } },
        select: { contentId: true },
      }),
      this.prisma.savedItem.findMany({
        where: { userWawuId: viewerWawuId, contentId: { in: ids } },
        select: { contentId: true },
      }),
      this.prisma.followRelationship.findMany({
        where: {
          followerWawuId: viewerWawuId,
          followingWawuId: { in: creators },
        },
        select: { followingWawuId: true },
      }),
      this.prisma.contentShare.groupBy({
        by: ['contentId'],
        where: { contentId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    return {
      liked: new Set(liked.map((r) => r.contentId)),
      saved: new Set(saved.map((r) => r.contentId)),
      follows: new Set(follows.map((r) => r.followingWawuId)),
      shares: new Map(shareCounts.map((r) => [r.contentId, r._count._all])),
    };
  }

  /**
   * GET /feed. `for_you` is the ranked browse GET /content serves; `following`
   * is only the people the viewer follows, newest first. Each card carries the
   * viewer's own flags.
   */
  async feed(
    viewerWawuId: string,
    tab: 'for_you' | 'following',
    category: string | undefined,
    sort: ContentSort,
    page: number,
    perPage: number,
  ): Promise<Paginated<FeedItem>> {
    const result = await this.content.list(
      viewerWawuId,
      tab === 'following' ? 'following' : 'feed',
      category,
      page,
      perPage,
      sort,
    );
    const state = await this.stateFor(viewerWawuId, result.items);
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        likedByMe: state.liked.has(item.id),
        savedByMe: state.saved.has(item.id),
        followsCreator: state.follows.has(item.creatorWawuId),
        shares: state.shares.get(item.id) ?? 0,
      })),
    };
  }

  /** GET /feed/following/count: how many people the viewer follows. */
  async followingCount(viewerWawuId: string): Promise<FollowingCount> {
    const count = await this.prisma.followRelationship.count({
      where: { followerWawuId: viewerWawuId },
    });
    return { count };
  }

  /**
   * GET /content/:id/engagement: the counts and the viewer's flags for one
   * piece, for the detail screen. Visible to whoever may read the piece: live
   * for anyone, any non-removed status for its owner.
   */
  async engagement(
    contentId: string,
    viewerWawuId: string,
  ): Promise<ContentEngagement> {
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        status: true,
        creatorWawuId: true,
        likes: true,
        views: true,
        commentCount: true,
      },
    });
    const visible =
      piece &&
      piece.status !== 'removed' &&
      (piece.status === 'live' || piece.creatorWawuId === viewerWawuId);
    if (!piece || !visible) throw new NotFoundException('Content not found');

    const state = await this.stateFor(viewerWawuId, [piece]);
    return {
      likes: piece.likes,
      views: piece.views,
      shares: state.shares.get(piece.id) ?? 0,
      commentCount: piece.commentCount,
      likedByMe: state.liked.has(piece.id),
      savedByMe: state.saved.has(piece.id),
      followsCreator: state.follows.has(piece.creatorWawuId),
    };
  }
}
