import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { EventTicketingController } from './event-ticketing.controller';
import { EventTicketingService } from './event-ticketing.service';
import { EventRunningController } from './event-running.controller';
import { EventRunningService } from './event-running.service';

/**
 * Event ticketing.
 *
 * DirectMessageModule is imported for its FLUTTERWAVE_CLIENT — the same
 * charge/verify/refund boundary paid DMs use. Reusing it rather than standing
 * up a second Flutterwave client is what makes a cancelled event's refunds
 * behave exactly like a missed DM's: the refund adapter, its retry semantics
 * and its "accepted is not settled" distinction are already right there.
 *
 * EventRunningController (EVENTS-05) serves the organiser's numbers and the
 * door staff; WawuAuthModule also gives it WawuIdClient for holder names.
 */
@Module({
  imports: [WawuAuthModule, DirectMessageModule],
  controllers: [EventTicketingController, EventRunningController],
  providers: [EventTicketingService, EventRunningService],
  exports: [EventTicketingService],
})
export class EventTicketingModule {}
