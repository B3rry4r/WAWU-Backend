import { Module } from '@nestjs/common';
import { PriceListModule } from '../price-list/price-list.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { EventCancelHooks } from './event-cancel-hooks';
import { EventTicketingController } from './event-ticketing.controller';
import { EventTicketingService } from './event-ticketing.service';
import { EventRunningController } from './event-running.controller';
import { EventRunningService } from './event-running.service';
import { EventHeldTicketsController } from './event-held-tickets.controller';
import { EventHeldTicketsService } from './event-held-tickets.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { EventServiceModule } from '../event/event-service.module';
import { PlansModule } from '../plans/plans.module';

/**
 * Event ticketing.
 *
 * DirectMessageModule is imported for its FLUTTERWAVE_CLIENT — the same
 * charge/verify/refund boundary paid DMs use. Reusing it rather than standing
 * up a second Flutterwave client is what makes a cancelled event's refunds
 * behave exactly like a missed DM's: the refund adapter, its retry semantics
 * and its "accepted is not settled" distinction are already right there.
 *
 * EventCancelHooks lets the wallet module (EVENTS-10) send the held prices of
 * a called-off event back to their buyers without this module importing it.
 *
 * EventRunningController (EVENTS-05) serves the organiser's numbers and the
 * door staff; WawuAuthModule also gives it WawuIdClient for holder names.
 *
 * EventServiceModule is imported for EventService's hosting gate (R-40):
 * PUT /events/:id/tickets refuses the hosts POST and PATCH /events refuse,
 * with the same check rather than a second copy of it. It has no
 * controller, so no route moves.
 */
@Module({
  imports: [
    WawuAuthModule,
    DirectMessageModule,
    BlockedAccountModule,
    EventServiceModule,
    // HostTierOffersInterceptor on PUT /events/:id/tickets (EVENTS-12).
    PlansModule,
    // Ticket prices are on the price list for the app's requests (PRICE-LIST round 2).
    PriceListModule,
  ],
  controllers: [
    EventTicketingController,
    EventRunningController,
    EventHeldTicketsController,
  ],
  providers: [
    EventTicketingService,
    EventRunningService,
    EventHeldTicketsService,
    EventCancelHooks,
  ],
  exports: [EventTicketingService, EventCancelHooks],
})
export class EventTicketingModule {}
