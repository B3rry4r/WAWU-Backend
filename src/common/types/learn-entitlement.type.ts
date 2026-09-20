/**
 * LearnEntitlement has NO Prisma model (see prisma/schema.prisma header
 * comment) — every field is derived from whether a CreatorState row exists
 * plus CourseEnrollment rows. Wire-response interface only.
 *
 * `tier` is gone with subscriptions: a field that always reported the same
 * value would be a label pretending to be a distinction.
 */
export interface LearnEntitlement {
  /** Flat per creator account; see learn-entitlement.service.ts. */
  freeCoursesTotal: number;
  freeCoursesUsed: number;
  enrolledCourseIds: string[];
}
