import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { NotificationModule } from '../notification/notification.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { TgifContentService } from '../tgif/content/tgif-content.service';
import { TgifDailyNoticeService } from './tgif-daily-notice.service';
import { TgifNoticeRetentionService } from './tgif-notice-retention.service';

/**
 * Time-based work for the whole API. Registered once in AppModule alongside
 * ScheduleModule.forRoot(); see SchedulerService for what each sweep does.
 * TgifDailyNoticeService (HOME-16) is the daily TGIF notification and
 * TgifNoticeRetentionService (HOME-17) clears its old notices; each has its
 * own file and its own @Cron so SchedulerService's constructor is unchanged.
 * Both read their figures from the admin settings (PlanSettingsModule).
 */
@Module({
  imports: [NotificationModule, DirectMessageModule, PlanSettingsModule],
  providers: [
    SchedulerService,
    TgifDailyNoticeService,
    TgifNoticeRetentionService,
    TgifContentService,
  ],
})
export class SchedulerModule {}
