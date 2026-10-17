import { Module } from '@nestjs/common';
import { WawuIdMailRelay } from '../../admin/notifications/email/email-provider';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { SchoolEnrolmentService } from './school-enrolment.service';
import { SchoolReportService } from './school-report.service';

/**
 * Enrolling in a course and paying for it from the wallet (task SCHOOLS-07):
 * the routes under `schools/enrolments` and the `school_fee` payment kind
 * registered with MONEY-17's pay from wallet. Mounted by SchoolsPublicModule
 * (which AppModule already reaches through the search module), as the apply
 * link is, so `src/app.module.ts` is untouched. The controller is registered
 * there too, ahead of the public `schools/:id` controller: `GET
 * schools/enrolments` (My courses, SCHOOLS-09) is one segment under `schools`
 * and would otherwise be read as a school's id.
 */
@Module({
  imports: [WawuAuthModule, MoneyModule],
  providers: [SchoolEnrolmentService, SchoolReportService, WawuIdMailRelay],
  exports: [SchoolEnrolmentService, SchoolReportService],
})
export class SchoolEnrolmentsModule {}
