import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { Comment } from '../common/types';
import type { CreateCommentDto } from './dto/create-comment.dto';

/**
 * Comment resource — registry.json "Comment". Both endpoints require an
 * authenticated WAWU user (roles: ["any"]); no creator-gate involved.
 */
@Injectable()
export class CommentService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertContentExists(contentId: string): Promise<void> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { id: true },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }
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

    return { items, currentPage: page, perPage, total };
  }

  async create(contentId: string, authorWawuId: string, dto: CreateCommentDto): Promise<Comment> {
    await this.assertContentExists(contentId);

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
