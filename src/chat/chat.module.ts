import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { StorageModule } from '../storage/storage.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * Free chat between two users (task INBOX-06). PrismaService comes from the
 * global PrismaModule and BlockedAccountService from the global
 * BlockedAccountModule; WawuAuthModule supplies WawuIdClient (names) and
 * StorageModule the presigner for attachments.
 */
@Module({
  imports: [WawuAuthModule, StorageModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
