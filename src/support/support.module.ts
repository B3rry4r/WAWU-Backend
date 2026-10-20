import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ChatModule } from '../chat/chat.module';
import { LivePublisherModule } from '../live/live-publisher.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/** Support chat (task SUPPORT-01): the person's side. PrismaService is global. */
@Module({
  imports: [WawuAuthModule, ChatModule, LivePublisherModule],
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
