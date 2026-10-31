import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminContentReviewModule } from '../admin/content-review/admin-content-review.module';
import { UserSuspensionModule } from '../user-suspension/user-suspension.module';
import { WawuIdMailRelay } from '../admin/notifications/email/email-provider';
import { AdminUgcReportsController } from './admin-ugc-reports.controller';
import { AdminUgcReportsService } from './admin-ugc-reports.service';
import { UgcReportMailService } from './ugc-report-mail.service';
import { UgcReportController } from './ugc-report.controller';
import { UgcReportService } from './ugc-report.service';

/** REPORT-UGC: report a piece, comment, profile, community message, chat message or paid question; the moderators' queue. */
@Module({
  imports: [
    ConfigModule,
    WawuAuthModule,
    AdminAuthModule,
    AdminContentReviewModule,
    UserSuspensionModule,
  ],
  controllers: [UgcReportController, AdminUgcReportsController],
  providers: [
    UgcReportService,
    UgcReportMailService,
    AdminUgcReportsService,
    WawuIdMailRelay,
  ],
})
export class UgcReportModule {}
