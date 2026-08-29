import { Controller, Get, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { LearnEntitlementService } from './learn-entitlement.service';
import type { LearnEntitlement } from '../common/types';

/**
 * registry.json "LearnEntitlement": GET /learn/entitlement, `roles: ["any"]`
 * — any authenticated WAWU user. Unlike LearnCourse's public catalog, this
 * response is user-scoped (derived from the caller's own CreatorState +
 * CourseEnrollment rows), so it requires auth to know whose entitlement to
 * compute — same distinction as Comment vs LearnCourse in wave 0.
 */
@UseGuards(WawuAuthGuard)
@Controller('learn/entitlement')
export class LearnEntitlementController {
  constructor(
    private readonly learnEntitlementService: LearnEntitlementService,
  ) {}

  @Get()
  get(@CurrentUser() user: WawuJwtClaims): Promise<LearnEntitlement> {
    return this.learnEntitlementService.getForUser(user.sub);
  }
}
