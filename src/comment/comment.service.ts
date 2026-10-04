import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { Comment, CommentAuthor } from '../common/types';
import type { CreateCommentDto } from './dto/create-comment.dto';

/**
 * Comment resource — registry.json "Comment". Both endpoints require an
 * authenticated WAWU user (roles: ["any"]); no creator-gate involved.
 */
@Injectable()
export class CommentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockedAccounts: BlockedAccountService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /**
   * Batch author-identity lookup for a page of comments — same shape as
   * CommunityMessageService.lookupSenders / DirectMessageService
   * .lookupOtherParties: one WawuIdClient.lookupPublicIdentities call plus
   * one userProfile.findMany, merged by id. Called once per page in list(),
   * not once per row — this is the fix for comments rendering a bare
   * `authorWawuId` (a UUID) where a name belongs, which `list()` had never
   * resolved at all.
   */
  private async lookupAuthors(
    authorIds: string[],
  ): Promise<Map<string, CommentAuthor>> {
    const unique = [...new Set(authorIds)];
    const out = new Map<string, CommentAuthor>();
    if (unique.length === 0) return out;

    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));

    for (const id of unique) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        wawuId: id,
        name: fullName || profile?.handle || '',
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        // An author with no profile row on this service has no ticks. Derived
        // through the one function, never compared inline.
        verification: deriveVerificationState(profile ?? null),
      });
    }
    return out;
  }

  /**
   * Returns the row rather than void so `create` can gate on the creator
   * without a second query — see the blocking check there.
   */
  private async assertContentExists(
    contentId: string,
  ): Promise<{ id: string; creatorWawuId: string }> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { id: true, creatorWawuId: true },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }
    return content;
  }

  /**
   * Finds the comment and asserts it belongs to `contentId` — the same shape
   * as the `replyToId` check in `create()`, reused here so a caller cannot
   * like a comment by guessing an id under the wrong content path.
   */
  private async assertCommentOnContent(
    contentId: string,
    commentId: string,
  ): Promise<{ id: string }> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, contentId: true },
    });
    if (!comment || comment.contentId !== contentId) {
      throw new NotFoundException('Comment not found');
    }
    return comment;
  }

  async list(
    contentId: string,
    requesterWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<Comment>> {
    const content = await this.assertContentExists(contentId);
    // SETTINGS-04: the thread under a hidden creator's piece is gone with
    // the piece, and inside any thread the comments of people the caller
    // blocked (or who blocked the caller) are left out, and not counted.
    await this.blockedAccounts.assertVisible(
      requesterWawuId,
      content.creatorWawuId,
      'Content not found',
    );
    const hidden = await this.blockedAccounts.hiddenFrom(requesterWawuId);
    const where = { contentId, authorWawuId: { notIn: hidden } };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.comment.count({ where }),
    ]);

    const [authors, likedIds] = await Promise.all([
      this.lookupAuthors(items.map((c) => c.authorWawuId)),
      this.prisma.commentLike
        .findMany({
          where: {
            userWawuId: requesterWawuId,
            commentId: { in: items.map((c) => c.id) },
          },
          select: { commentId: true },
        })
        .then((rows) => new Set(rows.map((r) => r.commentId))),
    ]);
    const enriched: Comment[] = items.map((c) => ({
      ...c,
      author: authors.get(c.authorWawuId),
      likedByMe: likedIds.has(c.id),
    }));

    return { items: enriched, currentPage: page, perPage, total };
  }

  /**
   * POST/DELETE .../comments/:commentId/like. Both idempotent: liking an
   * already-liked comment, or unliking one that isn't, changes nothing and
   * still returns the current, real count — the response is always the
   * server's own truth, never an assumption about what the caller's request
   * did.
   *
   * `CommentLike`'s unique (user, comment) constraint is what makes the
   * "already liked" case safe to just swallow rather than pre-checking: two
   * concurrent likes from the same user race on the same constraint, and only
   * one can ever win, so `Comment.likes` can't be double-incremented under
   * concurrency the way a read-then-write would allow.
   */
  async setLiked(
    contentId: string,
    commentId: string,
    userWawuId: string,
    liked: boolean,
  ): Promise<{ likes: number; likedByMe: boolean }> {
    await this.assertCommentOnContent(contentId, commentId);

    if (liked) {
      try {
        await this.prisma.$transaction([
          this.prisma.commentLike.create({ data: { userWawuId, commentId } }),
          this.prisma.comment.update({
            where: { id: commentId },
            data: { likes: { increment: 1 } },
          }),
        ]);
      } catch (e) {
        const isDuplicateLike =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002';
        if (!isDuplicateLike) throw e;
        // Already liked by this user — no-op, per the idempotency contract.
      }
    } else {
      const { count } = await this.prisma.commentLike.deleteMany({
        where: { userWawuId, commentId },
      });
      if (count > 0) {
        await this.prisma.comment.update({
          where: { id: commentId },
          data: { likes: { decrement: 1 } },
        });
      }
    }

    const comment = await this.prisma.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { likes: true },
    });
    return { likes: comment.likes, likedByMe: liked };
  }

  async create(
    contentId: string,
    authorWawuId: string,
    dto: CreateCommentDto,
  ): Promise<Comment> {
    const content = await this.assertContentExists(contentId);

    // Blocking gate. Reading a public content page is still allowed (the
    // list endpoint above is untouched) — what a block stops is talking AT
    // the other party. Symmetric, like every other block check.
    await this.blockedAccounts.assertNotBlocked(
      authorWawuId,
      content.creatorWawuId,
      'You cannot comment on this content.',
    );

    if (dto.replyToId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: dto.replyToId },
        select: { id: true, contentId: true },
      });
      if (!parent || parent.contentId !== contentId) {
        throw new BadRequestException(
          'replyToId must reference an existing comment on this content',
        );
      }
    }

    const [comment] = await this.prisma.$transaction([
      this.prisma.comment.create({
        data: {
          contentId,
          authorWawuId,
          text: dto.text,
          replyToId: dto.replyToId ?? null,
        },
      }),
      this.prisma.contentPiece.update({
        where: { id: contentId },
        data: { commentCount: { increment: 1 } },
      }),
    ]);

    return comment;
  }
}
