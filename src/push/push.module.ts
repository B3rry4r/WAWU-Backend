import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { ExpoPushClient } from './expo-push.client';
import { PushSenderService } from './push-sender.service';
import { PushSweepService } from './push-sweep.service';
import { PushTokenController } from './push-token.controller';
import { PushTokenService } from './push-token.service';

/**
 * Phone push (task INBOX-03): token registration, and the sender that sits
 * behind NotificationService. Registration line for src/app.module.ts:
 * one import and one entry in the `imports` array. BlockedAccountModule is
 * imported so the sender can ask about blocks; PushTokenService is exported
 * so a scheduled account deletion can forget the person's phones.
 */
@Module({
  imports: [NotificationModule, BlockedAccountModule],
  controllers: [PushTokenController],
  providers: [
    ExpoPushClient,
    PushTokenService,
    PushSenderService,
    PushSweepService,
  ],
  exports: [PushSenderService, PushTokenService],
})
export class PushModule {}
