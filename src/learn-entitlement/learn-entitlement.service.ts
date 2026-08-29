import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LearnEntitlement } from '../common/types';
import type { CreatorTier } from '../../generated/prisma/enums';

/**
 * Free course slots per tier.
 *
 * Basic 1, Pro 2, Pro Max 3 — from the plan copy, which sells Pro as "up to 2
 * training courses" and Pro Max as "up to 3". Pro previously gave 3; that is
 * the figure that moved when Pro Max was introduced above it, and it is the
 * one thing in this change that takes something away from an existing tier.
 */
const FREE_COURSES_BY_TIER: Record<CreatorTier, number> = {
  basic: 1,
  pro: 2,
  pro_max: 3,
};

/**
 * LearnEntitlement (registry.json) has no Prisma model of its own — every
 * field is derived from CreatorState.tier + CourseEnrollment rows (see
 * prisma/schema.prisma header comment and src/common/types/learn-entitlement.type.ts).
 * This service is a pure read/aggregation, never a writer.
 */
@Injectable()
export class LearnEntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /learn/entitlement for the current user. A plain (non-creator)
   * account has no CreatorState row: the perk belongs to the creator
   * subscription, so `freeCoursesTotal` is 0 and `tier` reports the
   * `basic` default (display-only — it is not gating anything at 0 slots).
   * `enrolledCourseIds` always lists every CourseEnrollment row regardless
   * of tier/cap — enrollment itself is not this resource's concern (no
   * enrol endpoint exists in this contract), only reporting usage against it.
   */
  async getForUser(wawuUserId: string): Promise<LearnEntitlement> {
    const [creatorState, enrollments] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.courseEnrollment.findMany({
        where: { userWawuId: wawuUserId },
        select: { courseId: true },
      }),
    ]);

    const tier = creatorState?.tier ?? 'basic';
    const freeCoursesTotal = creatorState ? FREE_COURSES_BY_TIER[tier] : 0;
    const enrolledCourseIds = enrollments.map((e) => e.courseId);
    const freeCoursesUsed = Math.min(
      enrolledCourseIds.length,
      freeCoursesTotal,
    );

    return {
      tier,
      freeCoursesTotal,
      freeCoursesUsed,
      enrolledCourseIds,
    };
  }
}
