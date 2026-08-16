import { Module } from '@nestjs/common';
import { NotificationSettingsController } from './notification-settings.controller';
import { NotificationSettingsService } from './notification-settings.service';

/**
 * Registration line for src/app.module.ts (applied centrally by the
 * dispatcher, see this agent's report):
 *   import { NotificationSettingsModule } from './notification-settings/notification-settings.module';
 *   // add NotificationSettingsModule to the `imports` array
 */
@Module({
  controllers: [NotificationSettingsController],
  providers: [NotificationSettingsService],
})
export class NotificationSettingsModule {}
