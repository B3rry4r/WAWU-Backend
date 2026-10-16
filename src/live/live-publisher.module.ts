import { Module } from '@nestjs/common';
import { LivePublisher } from './live-publisher.service';

/**
 * The sending half of live updates (INBOX-02): a module a feature imports to
 * signal a change. It is separate from LiveModule so the chat and community
 * modules can use it while LiveModule uses them. PrismaService comes from the
 * global PrismaModule.
 */
@Module({
  providers: [LivePublisher],
  exports: [LivePublisher],
})
export class LivePublisherModule {}
