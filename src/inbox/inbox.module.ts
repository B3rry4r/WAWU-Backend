import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/**
 * The inbox (task INBOX-07). PrismaService comes from the global
 * PrismaModule and BlockedAccountService from the global BlockedAccountModule;
 * DirectMessageModule supplies the batch name lookup the paid-question
 * threads already use.
 */
@Module({
  imports: [WawuAuthModule, DirectMessageModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
