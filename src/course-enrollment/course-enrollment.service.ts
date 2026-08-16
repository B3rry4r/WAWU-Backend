import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { LearnEntitlementService } from '../learn-entitlement/learn-entitlement.service';
import type { LearnEntitlement } from '../common/types';

/**
 * Wire response for POST /learn/courses/:id/enrol — the frozen contract's
 * `LearnEntitlement` shape plus `externalHostUrl` (registry note: "Handoff
 * to externalHostUrl" — the just-(re)enrolled course's LearnCourse.externalHostUrl
 * is how the frontend actually opens the content; it is not built here).
 * Kept local to this resource rather than added to common/types since it is
 * not itself a registry.json resource — it is this one endpoint's response.
 */
export interface EnrolResponse extends LearnEntitlement {
  externalHostUrl: string;
}

/**
 * CourseEnrollment resource — registry.json "CourseEnrollment". Frozen
 * contract is exactly one endpoint: POST /learn/courses/:id/enrol
 * (`roles: ["any"]`). Business rule (registry note): "Spends a free-course
 * slot (freeCoursesTotal derived from CreatorState.tier: basic=1, pro=3)".
 *
 * JUDGMENT: rather than re-deriving the tier/slot math here, this service
 * reuses LearnEntitlementService.getForUser — the exact same computation
 * GET /learn/entitlement already returns — both to decide whether a slot
 * remains and to build the fresh entitlement snapshot returned after
 * enrolling. LearnEntitlementModule does not export its service (nothing
 * in that module's `providers`/`exports` is this resource's to change per
 * the build brief's directory-scope rule), so LearnEntitlementService is
 * instead listed directly as a provider of THIS module too. It is a plain
 * stateless class depending only on the global PrismaService, so a second
 * Nest-managed instance is behaviorally identical to importing one — same
 * source file, no duplicated logic, no shared state to diverge.
 */
@Injectable()
export class CourseEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly learnEntitlementService: LearnEntitlementService,
  ) {}

  /**
   * Idempotent by design: the `@@unique([userWawuId, courseId])` constraint
   * means re-enrolling in a course you're already enrolled in is not an
   * error — it simply returns your current entitlement state (no slot is
   * spent twice). Only a *new* enrollment checks/spends a free-course slot.
   */
  async enrol(userWawuId: string, courseId: string): Promise<EnrolResponse> {
    const course = await this.prisma.learnCourse.findUnique({
      where: { id: courseId },
      select: { id: true, externalHostUrl: true },
    });
    if (!course) {
      throw new NotFoundException('Course not found');
    }

    const existing = await this.prisma.courseEnrollment.findUnique({
      where: { userWawuId_courseId: { userWawuId, courseId } },
      select: { id: true },
    });

    if (!existing) {
      const entitlement = await this.learnEntitlementService.getForUser(userWawuId);
      if (entitlement.freeCoursesUsed >= entitlement.freeCoursesTotal) {
        throw new ForbiddenException(
          'No free-course slots remaining. Free course slots come from an active, paid creator subscription (basic=1, pro=3).',
        );
      }

      await this.prisma.courseEnrollment.create({
        data: { userWawuId, courseId },
      });
    }

    const fresh = await this.learnEntitlementService.getForUser(userWawuId);
    return { ...fresh, externalHostUrl: course.externalHostUrl };
  }
}
