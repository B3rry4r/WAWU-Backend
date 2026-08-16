import { Module } from '@nestjs/common';
import { CourseEnrollmentController } from './course-enrollment.controller';
import { CourseEnrollmentService } from './course-enrollment.service';
import { LearnEntitlementService } from '../learn-entitlement/learn-entitlement.service';

/**
 * registry.json "CourseEnrollment" resource module. PrismaService comes
 * from the globally-registered PrismaModule (conventions.md § ORM /
 * database) — not re-imported here.
 *
 * LearnEntitlementService is listed as a provider here too (see the doc
 * comment on CourseEnrollmentService) rather than importing
 * LearnEntitlementModule, because that module does not export its service
 * and this build's scope is limited to src/course-enrollment/ only.
 */
@Module({
  controllers: [CourseEnrollmentController],
  providers: [CourseEnrollmentService, LearnEntitlementService],
})
export class CourseEnrollmentModule {}
