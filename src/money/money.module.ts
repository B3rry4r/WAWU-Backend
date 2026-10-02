import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MoneyPinController } from './pin/money-pin.controller';
import { TransactionPinGuard } from './pin/transaction-pin.guard';
import { TransactionPinService } from './pin/transaction-pin.service';

/**
 * The served half of the Naira wallet contract. Routes move here from
 * MoneyContractModule (declared, not mounted) as their tasks build them;
 * docs/contract/CONVENTIONS.md section 0.
 *
 * MONEY-09: the transaction PIN. A module that adds a debit route imports
 * this one and puts `@RequireTransactionPin()` on the route: the guard and
 * its service are exported for that.
 */
@Module({
  imports: [ConfigModule],
  controllers: [MoneyPinController],
  providers: [TransactionPinService, TransactionPinGuard],
  exports: [TransactionPinService, TransactionPinGuard],
})
export class MoneyModule {}
