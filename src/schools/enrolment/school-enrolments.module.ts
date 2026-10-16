import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { SchoolEnrolmentsController } from './school-enrolments.controller';
import { SchoolEnrolmentService } from './school-enrolment.service';

/**
 * Enrolling in a course and paying for it from the wallet (task SCHOOLS-07):
 * the routes under `schools/enrolments` and the `school_fee` payment kind
 * registered with MONEY-17's pay from wallet. Mounted by SchoolsPublicModule
 * (which AppModule already reaches through the search module), as the apply
 * link is, so `src/app.module.ts` is untouched.
 */
@Module({
  imports: [WawuAuthModule, MoneyModule],
  controllers: [SchoolEnrolmentsController],
  providers: [SchoolEnrolmentService],
  exports: [SchoolEnrolmentService],
})
export class SchoolEnrolmentsModule {}
