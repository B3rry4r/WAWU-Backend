import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { NotificationModule } from '../../notification/notification.module';
import { CommunityPassAccessModule } from './community-pass-access.module';
import { CommunityPassController } from './community-pass.controller';
import { CommunityPassReminderService } from './community-pass-reminder.service';
import { CommunityPassService } from './community-pass.service';

/**
 * A private community's monthly pass, paid from the wallet (task INBOX-24):
 * the routes under `communities/:id/pass`, the `community_pass` payment kind
 * registered with MONEY-17's pay from wallet, and the reminder 3 days before a
 * pass ends. It sits beside CommunityModule, not in it, so the web's community
 * routes and the specs that import CommunityModule do not need the wallet
 * provider's settings to boot; the read side every gated room needs is
 * CommunityPassAccessModule.
 *
 * Mounting it in AppModule is SHARED-CHANGES INBOX-24 #1 (one import and one
 * entry).
 */
@Module({
  imports: [
    WawuAuthModule,
    MoneyModule,
    BlockedAccountModule,
    NotificationModule,
    CommunityPassAccessModule,
  ],
  controllers: [CommunityPassController],
  providers: [CommunityPassService, CommunityPassReminderService],
})
export class CommunityPassModule {}
