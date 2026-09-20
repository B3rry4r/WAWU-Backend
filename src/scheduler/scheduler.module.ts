import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { NotificationModule } from '../notification/notification.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';

/**
 * Time-based work for the whole API. Registered once in AppModule alongside
 * ScheduleModule.forRoot(); see SchedulerService for what each sweep does.
 */
@Module({
  imports: [NotificationModule, DirectMessageModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
