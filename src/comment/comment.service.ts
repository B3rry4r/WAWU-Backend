import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
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
        select: { wawuUserId: true, handle: true, avatarUrl: true },
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
      });
    }
    return out;
  }

  /**
   * Returns the row rather than void so `create` can gate on the creator
   * without a second query — see the blocking check there.
   */
  private async assertContentExists(contentId: string): Promise<{ id: string; creatorWawuId: string }> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { id: true, creatorWawuId: true },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }
    return content;
  }

  async list(contentId: string, page: number, perPage: number): Promise<Paginated<Comment>> {
    await this.assertContentExists(contentId);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where: { contentId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.comment.count({ where: { contentId } }),
    ]);

    const authors = await this.lookupAuthors(items.map((c) => c.authorWawuId));
    const enriched: Comment[] = items.map((c) => ({
      ...c,
      author: authors.get(c.authorWawuId),
    }));

    return { items: enriched, currentPage: page, perPage, total };
  }

  async create(contentId: string, authorWawuId: string, dto: CreateCommentDto): Promise<Comment> {
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
        throw new BadRequestException('replyToId must reference an existing comment on this content');
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
