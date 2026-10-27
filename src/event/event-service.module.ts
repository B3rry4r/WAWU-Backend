import { Module } from '@nestjs/common';
import { VerificationStateModule } from '../common/verification/verification-state.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { PlansModule } from '../plans/plans.module';
import { EventService } from './event.service';
import { PriceListModule } from '../price-list/price-list.module';

/**
 * EventService on its own, with no controller (R-40, EVENTS-11).
 *
 * EventTicketingModule needs EventService for the hosting gate on PUT
 * /events/:id/tickets, the same check POST and PATCH /events run. It imports
 * this module rather than EventModule, so importing it registers no route
 * and moves none: EventController stays where AppModule puts it.
 *
 * PlansModule gives it the reader of a person's tier (MakerTierService): hosting
 * needs a running tier or a live tick (EVENTS-12, R-43).
 *
 * Its own file, not a second class in event.module.ts, so nothing that
 * imports it loads event.controller.ts either (the contract builder walks
 * controller files in the order the compiler meets them).
 */
@Module({
  imports: [
    VerificationStateModule,
    BlockedAccountModule,
    PlansModule,
    // Ticket prices are on the price list for the app's requests (PRICE-LIST round 2).
    PriceListModule,
  ],
  providers: [EventService],
  exports: [EventService],
})
export class EventServiceModule {}
