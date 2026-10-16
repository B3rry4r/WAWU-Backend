import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { EventWalletOrdersController } from './event-wallet-orders.controller';
import { EventWalletOrderService } from './event-wallet-order.service';

/**
 * Event tickets bought from the wallet (task EVENTS-07): the routes under
 * `events/:id/orders/wallet` and `events/orders/wallet`, and the `event_ticket`
 * payment kind registered with MONEY-17's pay from wallet. The web's
 * Flutterwave ticketing (EventTicketingModule) is untouched.
 *
 * Its own module, mounted by AppModule after MoneyModule: MoneyModule is
 * imported here, and importing it from EventTicketingModule would have
 * registered every money route earlier than it is today. The paths are
 * literals no route of the web matches.
 */
@Module({
  imports: [WawuAuthModule, MoneyModule, BlockedAccountModule],
  controllers: [EventWalletOrdersController],
  providers: [EventWalletOrderService],
})
export class EventWalletOrdersModule {}
