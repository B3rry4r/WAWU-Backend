import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ChatModule } from '../chat/chat.module';
import { LivePublisherModule } from '../live/live-publisher.module';
import { MoneyModule } from '../money/money.module';
import { MoneyRequestController } from './money-request.controller';
import { MoneyRequestPayGuard } from './money-request-pay.guard';
import { MoneyRequestService } from './money-request.service';

/**
 * Money requests in chat (task INBOX-15). PrismaService comes from the global
 * PrismaModule. ChatModule supplies the chat the request is written into;
 * MoneyModule supplies the wallet send that pays it, the wallet gate, the
 * Idempotency-Key and the PIN guard.
 */
@Module({
  imports: [WawuAuthModule, ChatModule, LivePublisherModule, MoneyModule],
  controllers: [MoneyRequestController],
  providers: [MoneyRequestService, MoneyRequestPayGuard],
  exports: [MoneyRequestService],
})
export class MoneyRequestModule {}
