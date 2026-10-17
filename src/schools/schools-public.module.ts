import { Module } from '@nestjs/common';
import { SchoolEnrolmentsController } from './enrolment/school-enrolments.controller';
import { SchoolEnrolmentsModule } from './enrolment/school-enrolments.module';
import { SchoolLinkController } from './school-link.controller';
import { SchoolLinkService } from './school-link.service';
import { SchoolsPublicController } from './schools-public.controller';
import { SchoolsPublicService } from './schools-public.service';

/**
 * Mounted by SearchResponseModule (which also needs the service for the
 * `schools` search tab), so `src/app.module.ts` is untouched. The apply link
 * (SCHOOLS-10) and enrolling in a course (SCHOOLS-07) ride in the same module
 * for the same reason.
 */
@Module({
  imports: [SchoolEnrolmentsModule],
  // The enrolments controller first: its `GET schools/enrolments` must be
  // matched before `GET schools/:id` (routes register in this order).
  controllers: [
    SchoolEnrolmentsController,
    SchoolsPublicController,
    SchoolLinkController,
  ],
  providers: [SchoolsPublicService, SchoolLinkService],
  exports: [SchoolsPublicService],
})
export class SchoolsPublicModule {}
