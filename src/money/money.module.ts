import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FintavaModule } from '../fintava/fintava.module';
import { MoneyBalanceController } from './balance/money-balance.controller';
import { LedgerModule } from './ledger/ledger.module';
import { WalletBalanceService } from './balance/wallet-balance.service';
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
 *
 * MONEY-11: the balance, read from Fintava through the MONEY-06 client on
 * every request. Importing FintavaModule here mounts that client in the app.
 * The server starts without any FINTAVA_* setting (the client is then
 * unconfigured and the balance answers 503); the settings are needed for the
 * wallet to work (deploy/README.md step 4).
 *
 * MONEY-10: the ledger (LedgerModule), fed from the stored Fintava
 * deliveries by a sweep. It adds no route.
 */
@Module({
  imports: [ConfigModule, FintavaModule, LedgerModule],
  controllers: [MoneyPinController, MoneyBalanceController],
  providers: [TransactionPinService, TransactionPinGuard, WalletBalanceService],
  exports: [TransactionPinService, TransactionPinGuard],
})
export class MoneyModule {}
