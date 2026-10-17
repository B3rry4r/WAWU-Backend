import { Module } from '@nestjs/common';
import { ChatModule } from '../../chat/chat.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminSupportController } from './admin-support.controller';

/**
 * Staff replies to support threads (task SUPPORT-01). Imports AdminAuthModule
 * for the guards and ChatModule for the chat service the replies go through.
 */
@Module({
  imports: [AdminAuthModule, ChatModule],
  controllers: [AdminSupportController],
})
export class AdminSupportModule {}
