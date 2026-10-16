import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { StorageModule } from '../storage/storage.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LivePublisherModule } from '../live/live-publisher.module';

/**
 * Free chat between two users (task INBOX-06). PrismaService comes from the
 * global PrismaModule and BlockedAccountService from the global
 * BlockedAccountModule; WawuAuthModule supplies WawuIdClient (names) and
 * StorageModule the presigner for attachments.
 */
@Module({
  imports: [WawuAuthModule, StorageModule, LivePublisherModule],
  controllers: [ChatController],
  providers: [ChatService],
  // The live gateway (INBOX-02) shows messages to each person in a chat.
  exports: [ChatService],
})
export class ChatModule {}
