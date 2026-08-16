import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CourseEnrollmentService, EnrolResponse } from './course-enrollment.service';

/**
 * registry.json "CourseEnrollment": POST /learn/courses/:id/enrol — note
 * the British spelling ("enrol"), the frozen route, not to be Americanized.
 * `roles: ["any"]` — any authenticated WAWU user, no creator gate (spending
 * a free-course slot requires an active creator subscription, but that is
 * a 403 business-rule check inside the service, not a route-level gate).
 */
@UseGuards(WawuAuthGuard)
@Controller('learn/courses/:id/enrol')
export class CourseEnrollmentController {
  constructor(private readonly courseEnrollmentService: CourseEnrollmentService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  enrol(
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<EnrolResponse> {
    return this.courseEnrollmentService.enrol(user.sub, courseId);
  }
}
