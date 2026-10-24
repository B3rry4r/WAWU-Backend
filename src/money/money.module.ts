import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MoneyBalanceController } from './balance/money-balance.controller';
import { MoneyHistoryController } from './history/money-history.controller';
import { TransactionHistoryService } from './history/transaction-history.service';
import { MoneyStatementController } from './statements/money-statement.controller';
import {
  StatementRateLimiter,
  StatementSlots,
} from './statements/statement-config';
import { StatementEmailService } from './statements/statement-email.service';
import { StatementService } from './statements/statement.service';
import { WawuIdMailRelay } from '../admin/notifications/email/email-provider';
import { LedgerModule } from './ledger/ledger.module';
import { MoneyInNoticeModule } from './money-in-notice/money-in-notice.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
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
import { SavedAccountTargetService } from './saved-accounts/saved-account-target.service';
import { PinRequestKeyFilter, PinRequestKeyGuard } from './pin/pin-request-key';
import {
  PinRequestFingerprints,
  PinRequestKeys,
} from './pin/pin-request-keys.service';
import { IdempotencyGuard, IdempotencyService } from './payments/idempotency';
import { MerchantWallet } from './payments/merchant-wallet';
import { HoldViewService } from './holds/hold-view.service';
import { MoneyHoldsController } from './holds/money-holds.controller';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminEarningsController } from './earnings/admin-earnings.controller';
import { EarningSettlementService } from './earnings/earning-settlement.service';
import { EarningsInReviewService } from './earnings/earnings-in-review.service';
import { EarningsViewService } from './earnings/earnings-view.service';
import { MoneyEarningsController } from './earnings/money-earnings.controller';
import { WalletHoldService } from './holds/wallet-hold.service';
import { MoneyPaymentsController } from './payments/money-payments.controller';
import { MoneyTransfersController } from './transfers/money-transfers.controller';
import {
  BankSendTargetGuard,
  BankSendTargets,
} from './transfers/bank-send-target';
import { MoneyBanksController } from './saved-accounts/money-banks.controller';
import { NameCheckBudget } from './saved-accounts/name-check-budget';
import { NameCheckTokenService } from './saved-accounts/name-check-token.service';
import { PayoutOwnNameGuard } from './transfers/payout-own-name.guard';
import {
  TransferRecipientGuard,
  TransferRecipients,
} from './transfers/transfer-recipient';
import { WalletTransferService } from './transfers/wallet-transfer.service';
import { PayableRegistry } from './payments/payable-registry';
import { PaymentSettings } from './payments/payment-config';
import { WalletPaymentService } from './payments/wallet-payment.service';
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
import { MoneyCheckSettings } from './check/money-check-config';
import { MoneyCheckMailer } from './check/money-check-mailer';
import { MoneyCheckScope } from './check/money-check-scope';
import { MoneyCheckService } from './check/money-check.service';
import { WalletProviderModule } from '../wallet-provider/wallet-provider.module';
import { MoneyLimitsModule } from './limits/money-limits.module';
import { NuvionDocumentsModule } from '../nuvion/documents/documents.module';
import { NuvionAddMoneyHandler } from '../nuvion/handlers/add-money.handler';
import { AddMoneySettings } from './add-money/add-money-config';
import { AddMoneyPrecheckGuard } from './add-money/add-money-precheck.guard';
import { AddMoneyService } from './add-money/add-money.service';
import { AdminAddMoneyController } from './add-money/admin-add-money.controller';
import {
  AddMoneyReturnController,
  MoneyAddMoneyController,
} from './add-money/add-money.controller';
import { FxAccountsService } from './fx/fx-accounts.service';
import { FxAdminController } from './fx/fx-admin.controller';
import { FxAdminService } from './fx/fx-admin.service';
import { FxController } from './fx/fx.controller';
import { FxOperationsService } from './fx/fx-operations.service';
import { FxPort } from './fx/fx-provider';
import { FxSettings } from './fx/fx-settings';
import { AdminOpsAuditModule } from '../common/audit/admin-ops-audit.module';
import { AdminCardsController } from './cards/admin-cards.controller';
import { AdminCardsService } from './cards/admin-cards.service';
import { CardCreatableGuard } from './cards/card-creatable.guard';
import { CardSettings } from './cards/card-config';
import { WalletCardPurge } from './cards/card-purge.service';
import {
  CardRevealLimitGuard,
  CardRevealLimiter,
} from './cards/card-reveal-limit';
import { AccountPurgeModule } from '../account-purge/account-purge.module';
import { MoneyCardsController } from './cards/money-cards.controller';
import { WalletCardService } from './cards/wallet-card.service';

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
 * every request. MONEY-20: every service here reaches the provider through
 * WalletProviderModule (`WALLET_PROVIDER`, `OTP_SENDER`), which mounts the
 * client and picks the adapter from WALLET_PROVIDER (`fintava` by default).
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
 * MONEY-17: pay from wallet (`GET /money/payments/quote`, `POST
 * /money/payments`): the price from the buyer's wallet to WAWU's merchant
 * wallet, with the 85/15 split recorded and the Idempotency-Key enforced,
 * plus a sweep that settles a payment whose answer was lost from the
 * ledger's status check (it runs where ScheduleModule.forRoot() is loaded).
 * Exported: PayableRegistry, where each selling feature registers its kind
 * (HOME-14, HOME-15, INBOX-16, ME-18, LEGAL-05, SCHOOLS-07, TIER-03); the
 * Idempotency-Key service and guard, for the sends (WALLET-07, WALLET-09),
 * through `@RequireIdempotentApproval()`. WalletPaymentService is exported for
 * a feature route that pays and answers its own view of the payment (TIER-03's
 * `POST /plans/purchases`: `quote`, `pay`, `view`, `presentRoute`).
 *
 * MONEY-18: hold, release and refund (`GET /money/holds`, `GET
 * /money/holds/{id}`). A held kind (paid DM, ticket, bill) registers with
 * PayableRegistry like any other; its payment completes into a `WalletHold`,
 * and the owning feature later releases it to the payee or refunds it to the
 * payer through the exported `WalletHoldService` (never a client request).
 * A sweep every minute settles a move whose answer was lost and tries again
 * what is waiting (a wallet not opened yet, a frozen one, the provider out of
 * reach); it runs where ScheduleModule.forRoot() is loaded.
 * WALLET-16: earnings land in the wallet by themselves (R-11). A sale of a
 * kind that is not held (an unlock, a tip, a legal fee, school fees) is paid
 * into WAWU's own account; when it is finished, `EarningSettlementService`
 * (exported; a sweep every minute, where ScheduleModule.forRoot() is loaded)
 * moves the payee's 85% from there into the payee's wallet: ONCE A DAY, in
 * one transfer per creator (R-55), and a day's total under N200 waits for
 * the next. A payee with no wallet keeps earning: the shares wait and are
 * moved the day the wallet opens. `GET /money/earnings` and `/money/earnings/content` read
 * what was earned from our records of the sales (not behind the wallet gate,
 * never a balance).
 * WALLET-18: receipts. The owner's routes (`/money/transactions/{id}/receipt`,
 * its image and its PDF) sit behind the wallet gate and read the row through
 * the history's detail; the public check (`/r/{code}`, no sign-in,
 * throttled) shows only what proves the movement. Neither calls Fintava.
 *
 * MONEY-16: the nightly check against the wallet provider
 * (`src/money/check/`). Once a night, at the hour in MONEY_CHECK_TIME (Lagos),
 * it compares every wallet's debits and balance, WAWU's own account, the money
 * held for payers and payees, and WAWU's charge on each send with the ledger,
 * lists what a person has to look at, and has the report emailed through WAWU
 * ID. It adds no route and only reads: a difference is reported, never fixed.
 * It runs where ScheduleModule.forRoot() is loaded; a run is claimed in the
 * database, so two Hub processes make one run. `npm run money:check` makes
 * it by hand.
 *
 * WALLET-08: finding a person to send money to (`/money/recipients`,
 * `/money/recipients/recent`), behind the wallet gate: only people with an
 * open wallet, never the caller, never anyone blocked either way
 * (BlockedAccountService), the recent ones from the ledger. It never calls
 * Fintava.
 *
 * WALLET-07: sending money to another WAWU user (`POST /money/transfers/wawu`,
 * `GET /money/transfers/{id}`): one wallet-to-wallet transfer from the
 * sender's wallet to the receiver's, the Idempotency-Key enforced, who the
 * money goes to checked before the PIN, and a sweep that settles a send whose
 * answer was lost from the provider's own record (it runs where
 * ScheduleModule.forRoot() is loaded). It never sends twice.
 *
 * WALLET-09: sending money to a bank account (`POST /money/transfers/bank`)
 * with the bank list and the name check (`GET /money/banks`, `POST
 * /money/banks/name-check`): the same send as WALLET-07's, to any Nigerian
 * bank account, the account name-checked with the bank before the PIN is
 * looked at, WAWU's limits checked in the claim (WALLET-23's included), and
 * a pending send found again by our reference.
 *
 * WALLET-27: statements (`/money/statements`), the caller's completed
 * movements over a period of Lagos days as a CSV file, behind the wallet
 * gate, read from the ledger only; it never calls Fintava.
 *
 * WALLET-10: money in, told once (`MoneyInNoticeModule`): a sweep over the
 * credited ledger rows writes one `money_in` notification per row, honouring
 * the person's "Money in" switch. It adds no route and never calls the
 * provider.
 *
 * WALLET-21 (R-83, R-84): dollar, euro, pound, Canadian dollar, dirham, cedi and
 * stablecoin accounts, swaps and crypto sends on Nuvion (`/money/fx`, src/money/fx/),
 * through WALLET_PROVIDER's optional `fx` port, with the admin reads and the
 * freeze (`/admin/money/fx`). A sweep every minute settles a swap or send whose
 * answer was lost from the provider's own record (it runs where
 * ScheduleModule.forRoot() is loaded).
 *
 * POINTS-04: points converted to cash (`/points/convert`, PointsConvertModule
 * in `src/points/convert/`). It pays out of WAWU's own account through the
 * exported `MerchantWallet`, the exported fee and Idempotency-Key services and
 * the wallet gate, with the PIN guard in front of the conversion.
 */
@Module({
  imports: [
    ConfigModule,
    // Only the admin guards, for the unswept-sales list (WALLET-16).
    AdminAuthModule,
    WalletProviderModule,
    LedgerModule,
    WawuAuthModule,
    BlockedAccountModule,
    // Limits (task NUV-07): validates the WAWU_LIMIT_* settings at boot and gives the
    // quote today's standing.
    MoneyLimitsModule,
    // Identity documents and the hosted selfie for a Nuvion opening (task NUV-03,
    // SHARED-CHANGES NUV-03 #1).
    NuvionDocumentsModule,
    // Money in, told once (task WALLET-10): the sweep over credited ledger rows.
    MoneyInNoticeModule,
    // The admin settings (task HOME-17): the name checks an hour are read live.
    PlanSettingsModule,
    // The audit row of support freezing or blocking a card (task WALLET-31).
    AdminOpsAuditModule,
    // The before-erase hook that blocks a person's cards (WALLET-31 round 1).
    AccountPurgeModule,
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
    MoneyPaymentsController,
    MoneyTransfersController,
    MoneyBanksController,
    MoneyHoldsController,
    MoneyEarningsController,
    AdminEarningsController,
    MoneyCardsController,
    AdminCardsController,
    MoneyReceiptController,
    PublicReceiptController,
    MoneyRecipientController,
    AddMoneyReturnController,
    MoneyAddMoneyController,
    AdminAddMoneyController,
    // WALLET-21 (R-83, R-84): foreign accounts, swaps and crypto sends, and the
    // admin reads and the freeze.
    FxController,
    FxAdminController,
  ],
  providers: [
    // Add money by card, Apple Pay, USSD and the bank checkout (WALLET-25, WALLET-26).
    AddMoneySettings,
    AddMoneyService,
    AddMoneyPrecheckGuard,
    NuvionAddMoneyHandler,
    FxPort,
    FxSettings,
    FxAccountsService,
    FxOperationsService,
    FxAdminService,
    // The WAWU card (task WALLET-31).
    CardSettings,
    WalletCardService,
    CardCreatableGuard,
    CardRevealLimiter,
    CardRevealLimitGuard,
    WalletCardPurge,
    AdminCardsService,
    WalletGate,
    WalletGateGuard,
    TransactionPinService,
    TransactionPinGuard,
    PinRequestFingerprints,
    PinRequestKeys,
    PinRequestKeyGuard,
    PinRequestKeyFilter,
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
    NameCheckTokenService,
    NameCheckBudget,
    BeneficiaryService,
    PayoutAccountService,
    SavedAccountTargetService,
    TransactionHistoryService,
    StatementService,
    StatementEmailService,
    WawuIdMailRelay,
    StatementRateLimiter,
    StatementSlots,
    FeeSettings,
    FeeQuoteService,
    PaymentSettings,
    IdempotencyService,
    IdempotencyGuard,
    MerchantWallet,
    PayableRegistry,
    WalletPaymentService,
    TransferRecipients,
    TransferRecipientGuard,
    BankSendTargets,
    BankSendTargetGuard,
    PayoutOwnNameGuard,
    WalletTransferService,
    HoldViewService,
    WalletHoldService,
    EarningSettlementService,
    EarningsViewService,
    EarningsInReviewService,
    ReceiptSettings,
    ReceiptService,
    RecipientService,
    RecipientSearchLimiter,
    MoneyCheckSettings,
    MoneyCheckMailer,
    MoneyCheckScope,
    MoneyCheckService,
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
    PaymentSettings,
    IdempotencyService,
    IdempotencyGuard,
    PayableRegistry,
    WalletPaymentService,
    // WAWU's own account at the provider, read once per process; exported for
    // the features that pay out of it (POINTS-04's cash-out).
    MerchantWallet,
    WalletHoldService,
    HoldViewService,
    MoneyCheckService,
    // INBOX-15: paying a money request is a send to the requester, made by
    // the same service (WALLET-07) with a hook that ties the request to the
    // send inside the send's claim; the recipient check answers before the PIN.
    WalletTransferService,
    TransferRecipients,
    EarningSettlementService,
  ],
})
export class MoneyModule {}
