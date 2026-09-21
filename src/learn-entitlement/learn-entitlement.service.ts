import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LearnEntitlement } from '../common/types';

/**
 * Free course slots, per creator account.
 *
 * This was a ladder keyed on CreatorState.tier: Basic 1, Pro 2, Pro Max 3,
 * from the plan copy. The tiers went with subscriptions, so the ladder
 * collapses to its floor — 1 — which is the number a creator on the cheapest
 * plan already had. Not an invented figure: the 2 and the 3 were bought with
 * plans that no longer exist, and the live API reports zero payments ever, so
 * no creator loses a slot they held.
 */
const FREE_COURSES_PER_CREATOR = 1;

/**
 * LearnEntitlement (registry.json) has no Prisma model of its own — every
 * field is derived from whether a CreatorState row exists plus
 * CourseEnrollment rows (see
 * prisma/schema.prisma header comment and src/common/types/learn-entitlement.type.ts).
 * This service is a pure read/aggregation, never a writer.
 */
@Injectable()
export class LearnEntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /learn/entitlement for the current user. A plain (non-creator)
   * account has no CreatorState row and gets `freeCoursesTotal: 0` — the perk
   * belongs to creator accounts. `enrolledCourseIds` always lists every
   * CourseEnrollment row regardless of the cap: enrollment itself is not this
   * resource's concern (no enrol endpoint exists in this contract), only
   * reporting usage against it.
   */
  async getForUser(wawuUserId: string): Promise<LearnEntitlement> {
    const [creatorState, enrollments] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.courseEnrollment.findMany({
        where: { userWawuId: wawuUserId },
        select: { courseId: true },
      }),
    ]);

    const freeCoursesTotal = creatorState ? FREE_COURSES_PER_CREATOR : 0;
    const enrolledCourseIds = enrollments.map((e) => e.courseId);
    const freeCoursesUsed = Math.min(
      enrolledCourseIds.length,
      freeCoursesTotal,
    );

    return {
      freeCoursesTotal,
      freeCoursesUsed,
      enrolledCourseIds,
    };
  }
}
