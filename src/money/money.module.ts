import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FintavaModule } from '../fintava/fintava.module';
import { MoneyBalanceController } from './balance/money-balance.controller';
import { MoneyHistoryController } from './history/money-history.controller';
import { TransactionHistoryService } from './history/transaction-history.service';
import { MoneyStatementController } from './statements/money-statement.controller';
import {
  StatementRateLimiter,
  StatementSlots,
} from './statements/statement-config';
import { StatementService } from './statements/statement.service';
import { LedgerModule } from './ledger/ledger.module';
import { WalletBalanceService } from './balance/wallet-balance.service';
import { FeeSettings } from './fees/fee-config';
import { FeeQuoteService } from './fees/fee-quote.service';
import { MoneyFeesController } from './fees/money-fees.controller';
import { WalletGate, WalletGateGuard } from './gate/wallet-gate';
import { IdentityHasher } from './identity/identity-config';
import { MoneyIdentityController } from './identity/money-identity.controller';
import { SelfieMatchService } from './identity/selfie-match.service';
import { WalletIdentityService } from './identity/wallet-identity.service';
import { MoneyWalletController } from './opening/money-wallet-opening.controller';
import { WalletOpeningSettings } from './opening/wallet-opening-config';
import { WalletOpeningService } from './opening/wallet-opening.service';
import { ApprovalDeviceService } from './pin/approval-device.service';
import { MoneyDeviceController } from './pin/money-device.controller';
import { MoneyPinResetController } from './pin/money-pin-reset.controller';
import { MoneyPinController } from './pin/money-pin.controller';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BankAccountCheckService } from './saved-accounts/bank-account-check.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { BeneficiaryService } from './saved-accounts/beneficiary.service';
import { MoneySavedAccountsController } from './saved-accounts/money-saved-accounts.controller';
import { PayoutAccountService } from './saved-accounts/payout-account.service';
import { PinResetSettings } from './pin/pin-reset-config';
import { PinResetService } from './pin/pin-reset.service';
import { TransactionPinGuard } from './pin/transaction-pin.guard';
import { TransactionPinService } from './pin/transaction-pin.service';
import { MoneyRecipientController } from './recipients/money-recipient.controller';
import { RecipientSearchLimiter } from './recipients/recipient-config';
import { RecipientService } from './recipients/recipient.service';
import { MoneyReceiptController } from './receipts/money-receipt.controller';
import { PublicReceiptController } from './receipts/public-receipt.controller';
import { ReceiptSettings } from './receipts/receipt-config';
import { ReceiptService } from './receipts/receipt.service';

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
 *
 * WALLET-14: saved beneficiaries and the payout account
 * (`/money/beneficiaries`, `/money/payout-account`), behind the wallet gate,
 * name-checked with the bank through the same client; WawuAuthModule
 * supplies WawuIdClient for the names of saved WAWU users.
 *
 * MONEY-13: the wallet gate (`src/money/gate/`). Every route that reads or
 * moves a person's wallet answers "no wallet yet" the same way, `409
 * wallet_not_open` (or `409 wallet_opening`), through `@RequireOpenWallet()`
 * or `@RequireTransactionPin()`, which brings it. The gate and its guard are
 * exported for the modules that add wallet routes.
 *
 * MONEY-14: the PIN reset by a code texted to the proved phone
 * (`/money/pin/reset`, through the same Fintava client) and biometric
 * approval (`/money/device`, `/money/approval/verify`). ApprovalDeviceService
 * is exported beside the guard: `@RequireApproval()` on a debit lets the
 * registered phone's fingerprint or face stand in for the PIN.
 *
 * MONEY-15: the history (`/money/transactions`, its month summary and one
 * row), behind the wallet gate, read from the ledger only; it never calls
 * Fintava.
 *
 * WALLET-15: the fee quote (`GET /money/fees/quote`), behind the wallet
 * gate, from the fee schedule in config (FeeSettings, R-10). It never calls
 * Fintava. FeeQuoteService is exported for the routes that charge what was
 * quoted (WALLET-07, WALLET-09, MONEY-17): they fill their fees from it and
 * check the quote the person saw with `check()`.
 *
 * WALLET-18: receipts. The owner's routes (`/money/transactions/{id}/receipt`,
 * its image and its PDF) sit behind the wallet gate and read the row through
 * the history's detail; the public check (`/r/{code}`, no sign-in,
 * throttled) shows only what proves the movement. Neither calls Fintava.
 *
 * WALLET-08: finding a person to send money to (`/money/recipients`,
 * `/money/recipients/recent`), behind the wallet gate: only people with an
 * open wallet, never the caller, never anyone blocked either way
 * (BlockedAccountService), the recent ones from the ledger. It never calls
 * Fintava.
 *
 * WALLET-27: statements (`/money/statements`), the caller's completed
 * movements over a period of Lagos days as a CSV file, behind the wallet
 * gate, read from the ledger only; it never calls Fintava.
 */
@Module({
  imports: [
    ConfigModule,
    FintavaModule,
    LedgerModule,
    WawuAuthModule,
    BlockedAccountModule,
  ],
  controllers: [
    MoneyPinController,
    MoneyPinResetController,
    MoneyDeviceController,
    MoneyBalanceController,
    MoneyIdentityController,
    MoneyWalletController,
    MoneySavedAccountsController,
    MoneyHistoryController,
    MoneyStatementController,
    MoneyFeesController,
    MoneyReceiptController,
    PublicReceiptController,
    MoneyRecipientController,
  ],
  providers: [
    WalletGate,
    WalletGateGuard,
    TransactionPinService,
    TransactionPinGuard,
    PinResetSettings,
    PinResetService,
    ApprovalDeviceService,
    WalletBalanceService,
    IdentityHasher,
    WalletIdentityService,
    SelfieMatchService,
    WalletOpeningSettings,
    WalletOpeningService,
    BankAccountCheckService,
    BeneficiaryService,
    PayoutAccountService,
    TransactionHistoryService,
    StatementService,
    StatementRateLimiter,
    StatementSlots,
    FeeSettings,
    FeeQuoteService,
    ReceiptSettings,
    ReceiptService,
    RecipientService,
    RecipientSearchLimiter,
  ],
  exports: [
    WalletGate,
    WalletGateGuard,
    TransactionPinService,
    TransactionPinGuard,
    ApprovalDeviceService,
    WalletIdentityService,
    SelfieMatchService,
    WalletOpeningService,
    FeeSettings,
    FeeQuoteService,
  ],
})
export class MoneyModule {}
