import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessType, TransactionStatus } from '../../generated/prisma/enums';
import type { CourseLessonResponse } from '../common/types';

/**
 * CourseLesson has no standalone endpoints (registry.json: `"endpoints": []`
 * for this resource — confirmed intentional by schema.prisma's own doc
 * comment on the CourseLesson model: "locked ... computed per-requester at
 * read time"). It exists only as data nested under a `course`-type
 * ContentPiece on the content-detail screen.
 *
 * This service is the single place that computes the `locked` field and is
 * meant to be injected by the ContentPiece module (a later build wave, per
 * the pipeline's wave-dependency model — CourseLesson has no dependency on
 * any other wave-0 resource, so it ships first as a pure building block).
 */
@Injectable()
export class CourseLessonService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * All lessons for a piece of content, ordered by `order`, with `locked`
   * derived for the given requester (registry note: "derived from purchase
   * state"). Returns `[]` if the content doesn't exist or has no lessons
   * (e.g. it isn't a `course`-type ContentPiece) — never throws for a
   * missing/non-course contentId, since this is read as an embedded list,
   * not a resource lookup in its own right.
   *
   * Lock rule (mirrors ContentPiece.fullAssetLocked — same purchase-gate
   * semantics, docs/02_TECHNICAL_CONTEXT.md §2.1/2.2):
   *   - free content → never locked
   *   - the content's own creator → never locked
   *   - requester has a `completed` Purchase for this contentId → unlocked
   *   - anonymous requester, or no completed purchase → locked
   */
  async getLessonsForContent(
    contentId: string,
    requesterWawuId?: string,
  ): Promise<CourseLessonResponse[]> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { accessType: true, creatorWawuId: true },
    });
    if (!content) {
      return [];
    }

    const locked = await this.isLocked(
      contentId,
      content.accessType,
      content.creatorWawuId,
      requesterWawuId,
    );

    const lessons = await this.prisma.courseLesson.findMany({
      where: { contentId },
      orderBy: { order: 'asc' },
    });

    return lessons.map((lesson) => ({ ...lesson, locked }));
  }

  private async isLocked(
    contentId: string,
    accessType: AccessType,
    creatorWawuId: string,
    requesterWawuId?: string,
  ): Promise<boolean> {
    if (accessType === AccessType.free) {
      return false;
    }
    if (!requesterWawuId) {
      return true;
    }
    if (requesterWawuId === creatorWawuId) {
      return false;
    }

    const purchase = await this.prisma.purchase.findFirst({
      where: {
        contentId,
        buyerWawuId: requesterWawuId,
        status: TransactionStatus.completed,
      },
      select: { id: true },
    });

    return purchase === null;
  }
}
