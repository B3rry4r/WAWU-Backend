/**
 * LearnEntitlement has NO Prisma model (see prisma/schema.prisma header
 * comment) — every field is fully derivable from CreatorState.tier +
 * CourseEnrollment rows. Wire-response interface only.
 */
export interface LearnEntitlement {
  tier: 'basic' | 'pro';
  /** derived from CreatorState.tier: basic=1, pro=3 per registry note. */
  freeCoursesTotal: number;
  freeCoursesUsed: number;
  enrolledCourseIds: string[];
}
