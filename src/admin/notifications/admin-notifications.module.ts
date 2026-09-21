import { Module } from '@nestjs/common';
import { NotificationModule } from '../../notification/notification.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationsService } from './admin-notifications.service';

/**
 * Admin notification campaigns - build brief C8's push/promotion channel.
 *
 * Imports exactly two things:
 *  - AdminAuthModule, for the guards and nothing else. It already exports
 *    AdminAuthGuard and AdminRolesGuard precisely so resource modules built
 *    after it do not re-implement them.
 *  - NotificationModule, for NotificationService.emitCampaign. That service
 *    remains the ONLY writer of the Notification table; this module composes
 *    a campaign and hands it over, it never inserts a notification itself.
 *
 * PrismaService arrives from the global PrismaModule. No app-facing module,
 * service, DTO or route is imported for writing, and none is modified.
 */
@Module({
  imports: [AdminAuthModule, NotificationModule],
  controllers: [AdminNotificationsController],
  providers: [AdminNotificationsService],
})
export class AdminNotificationsModule {}
