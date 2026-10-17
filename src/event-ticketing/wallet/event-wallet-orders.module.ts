import { Module } from '@nestjs/common';
import { AccountPurgeModule } from '../../account-purge/account-purge.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { EventTicketingModule } from '../event-ticketing.module';
import { EventCallOffRefundService } from './event-call-off-refund.service';
import { EventHostErasureService } from './event-host-erasure.service';
import { EventWalletOrdersController } from './event-wallet-orders.controller';
import { EventWalletOrderService } from './event-wallet-order.service';

/**
 * Event tickets bought from the wallet (task EVENTS-07): the routes under
 * `events/:id/orders/wallet` and `events/orders/wallet`, and the `event_ticket`
 * payment kind registered with MONEY-17's pay from wallet. The web's
 * Flutterwave ticketing (EventTicketingModule) is untouched.
 *
 * It also sends the price of a wallet order back to its buyer before the
 * account purge deletes an erased host's event (EventHostErasureService).
 *
 * It sends the held price of a called-off event back to every buyer, through
 * the same hold refund (EventCallOffRefundService, task EVENTS-10). The web's
 * cancel route reaches it through EventCancelHooks, so EventTicketingModule
 * never imports this module. EventTicketingModule is imported here only for
 * that registry; it is already mounted earlier by AppModule.
 *
 * Its own module, mounted by AppModule after MoneyModule: MoneyModule is
 * imported here, and importing it from EventTicketingModule would have
 * registered every money route earlier than it is today. The paths are
 * literals no route of the web matches.
 */
@Module({
  imports: [
    WawuAuthModule,
    MoneyModule,
    BlockedAccountModule,
    AccountPurgeModule,
    EventTicketingModule,
  ],
  controllers: [EventWalletOrdersController],
  providers: [
    EventWalletOrderService,
    EventHostErasureService,
    EventCallOffRefundService,
  ],
})
export class EventWalletOrdersModule {}
