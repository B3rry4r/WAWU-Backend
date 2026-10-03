import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FintavaModule } from '../fintava/fintava.module';
import { MoneyBalanceController } from './balance/money-balance.controller';
import { LedgerModule } from './ledger/ledger.module';
import { WalletBalanceService } from './balance/wallet-balance.service';
import { IdentityHasher } from './identity/identity-config';
import { MoneyIdentityController } from './identity/money-identity.controller';
import { SelfieMatchService } from './identity/selfie-match.service';
import { WalletIdentityService } from './identity/wallet-identity.service';
import { MoneyWalletController } from './opening/money-wallet-opening.controller';
import { WalletOpeningSettings } from './opening/wallet-opening-config';
import { WalletOpeningService } from './opening/wallet-opening.service';
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
 *
 * KYC-01: Open your wallet's identity step (`/money/identity`), the BVN
 * check through the same client. WalletIdentityService is exported for the
 * steps after it (KYC-02, MONEY-12), which check the BVN and NIN they are
 * sent against the ones that passed.
 *
 * KYC-02: the selfie match to the BVN photo (`/money/identity/selfie`),
 * through the same client. SelfieMatchService is exported for account
 * opening (MONEY-12), which needs the selfie to have matched.
 *
 * MONEY-12: opening the account at Fintava (`POST /money/wallet/open`) and
 * the wallet as WAWU records it (`GET /money/wallet`), with a sweep that
 * reconciles a lost create answer every 30 seconds (it runs where
 * ScheduleModule.forRoot() is loaded, AppModule). WalletOpeningService is
 * exported for the routes that answer `wallet_opening` (MONEY-13).
 */
@Module({
  imports: [ConfigModule, FintavaModule, LedgerModule],
  controllers: [
    MoneyPinController,
    MoneyBalanceController,
    MoneyIdentityController,
    MoneyWalletController,
  ],
  providers: [
    TransactionPinService,
    TransactionPinGuard,
    WalletBalanceService,
    IdentityHasher,
    WalletIdentityService,
    SelfieMatchService,
    WalletOpeningSettings,
    WalletOpeningService,
  ],
  exports: [
    TransactionPinService,
    TransactionPinGuard,
    WalletIdentityService,
    SelfieMatchService,
    WalletOpeningService,
  ],
})
export class MoneyModule {}
