import { Module } from '@nestjs/common';
import { NotificationModule } from '../../notification/notification.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationsService } from './admin-notifications.service';
import { EmailCampaignService } from './email/email-campaign.service';
import { AdminEmailController } from './email/email.controller';
import { ResendClient, WawuIdMailRelay } from './email/email-provider';
import { EmailSendingService } from './email/email-sending.service';
import { PublicEmailUnsubscribeController } from './email/email-unsubscribe.controller';

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
 * EMAIL-01 lives in ./email: the email campaign tool (templates, audiences,
 * a background send through Resend, a public unsubscribe route). It adds four
 * tables and touches nothing the app or the web calls.
 *
 * PrismaService arrives from the global PrismaModule. No app-facing module,
 * service, DTO or route is imported for writing, and none is modified.
 */
@Module({
  imports: [AdminAuthModule, NotificationModule],
  controllers: [
    AdminNotificationsController,
    AdminEmailController,
    PublicEmailUnsubscribeController,
  ],
  providers: [
    AdminNotificationsService,
    EmailCampaignService,
    EmailSendingService,
    ResendClient,
    WawuIdMailRelay,
  ],
})
export class AdminNotificationsModule {}
