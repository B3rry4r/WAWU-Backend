import { Module } from '@nestjs/common';
import { CreditSpendModule } from '../credit-spend/credit-spend.module';
import { CommunityMessageController } from './community-message.controller';
import { CommunityRoomModerationController } from './community-room-moderation.controller';
import { CommunityRoomModerationService } from './community-room-moderation.service';
import { CommunityMessageService } from './community-message.service';
import { CommunityMessageNoticeService } from './community-message-notice.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { NotificationModule } from '../notification/notification.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { LivePublisherModule } from '../live/live-publisher.module';
import { CommunityPassAccessModule } from '../community/pass/community-pass-access.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { StorageModule } from '../storage/storage.module';

/**
 * CommunityMessage resource module. PrismaService comes from the globally
 * registered PrismaModule (not re-imported here). Imports CreditSpendModule
 * to obtain CreditSpendService — CreditSpendModule exports it specifically
 * so this module can write the paid-message ledger row (see
 * credit-spend.module.ts's own doc comment). CreditsStateModule is
 * deliberately NOT imported: it doesn't export CreditsStateService, so this
 * resource reads/writes the CreditsState table directly via PrismaService
 * instead (see community-message.service.ts's doc comment). WawuAuthModule
 * supplies WawuIdClient, which list() batch-calls to attach each message's
 * sender identity (same source CreatorDiscoveryService already uses).
 * PlanSettingsModule gives it the price of each kind of message (INBOX-22,
 * R-62): the prices are admin settings, read at send time. StorageModule
 * gives it the bucket's own address, so a video or voice link is accepted
 * only when it is one of this bucket's (INBOX-22).
 */
@Module({
  imports: [
    NotificationModule,
    CreditSpendModule,
    WawuAuthModule,
    LivePublisherModule,
    BlockedAccountModule,
    CommunityPassAccessModule,
    PlanSettingsModule,
    // StorageService: the bucket's own address for the link check (INBOX-22), and
    // to sign a message's photo, video and voice note links again on the way out
    // (FIX-71).
    StorageModule,
  ],
  // MOD-ROOMS (R-122): the host's tools in their own room.
  controllers: [CommunityMessageController, CommunityRoomModerationController],
  // FIX-105 (R-81): the sweep that turns new messages into grouped notices.
  providers: [
    CommunityMessageService,
    CommunityMessageNoticeService,
    CommunityRoomModerationService,
  ],
  // CommunityModule's "my communities" (INBOX-01) reuses lookupSenders.
  exports: [CommunityMessageService, CommunityMessageNoticeService],
})
export class CommunityMessageModule {}
