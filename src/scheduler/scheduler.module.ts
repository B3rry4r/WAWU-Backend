import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { NotificationModule } from '../notification/notification.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { TgifContentService } from '../tgif/content/tgif-content.service';
import { TgifDailyNoticeService } from './tgif-daily-notice.service';

/**
 * Time-based work for the whole API. Registered once in AppModule alongside
 * ScheduleModule.forRoot(); see SchedulerService for what each sweep does.
 * TgifDailyNoticeService (HOME-16) is the daily TGIF notification; it has its
 * own file and its own @Cron so SchedulerService's constructor is unchanged.
 */
@Module({
  imports: [NotificationModule, DirectMessageModule],
  providers: [SchedulerService, TgifDailyNoticeService, TgifContentService],
})
export class SchedulerModule {}
