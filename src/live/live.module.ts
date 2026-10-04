import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatModule } from '../chat/chat.module';
import { CommunityMessageModule } from '../community-message/community-message.module';
import { LivePublisherModule } from './live-publisher.module';
import { LiveCatchUpService } from './live-catch-up.service';
import { LiveConnections } from './live-connections.service';
import { LiveDispatcher } from './live-dispatcher.service';
import { LiveListener } from './live-listener.service';
import { LiveTokenVerifier } from './live-token.verifier';
import { LiveController } from './live.controller';
import { LiveGateway } from './live.gateway';

/**
 * Live updates for chat (task INBOX-02): the WebSocket, the Postgres feed
 * that reaches every instance, and the catch-up route. Mounted once in
 * AppModule. PrismaService comes from the global PrismaModule and
 * BlockedAccountService from the global BlockedAccountModule; the chat and
 * community modules supply the views a person is shown.
 */
@Module({
  imports: [
    ConfigModule,
    ChatModule,
    CommunityMessageModule,
    LivePublisherModule,
  ],
  controllers: [LiveController],
  providers: [
    LiveTokenVerifier,
    LiveConnections,
    LiveDispatcher,
    LiveListener,
    LiveGateway,
    LiveCatchUpService,
  ],
})
export class LiveModule {}
