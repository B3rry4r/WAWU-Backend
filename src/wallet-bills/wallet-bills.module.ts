import { Module } from '@nestjs/common';
import { BillsCatalogueModule } from '../bills-catalogue/bills-catalogue.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { FintavaModule } from '../fintava/fintava.module';
import { LedgerModule } from '../money/ledger/ledger.module';
import { MoneyModule } from '../money/money.module';
import { WalletProviderModule } from '../wallet-provider/wallet-provider.module';
import { WalletBillsController } from './wallet-bills.controller';
import { WalletBillService } from './wallet-bill.service';

/**
 * Bills paid from the wallet (task BILLS-04): the routes under `bills/wallet`
 * and the `bill` payment kind registered with MONEY-17's pay from wallet.
 * Mounted by BillPaymentModule (which AppModule already mounts), as BILLS-01's
 * catalogue is, so `src/app.module.ts` is untouched. Bills stay on Fintava
 * whichever wallet provider runs (R-45): this module reaches Fintava through
 * its client for the purchase, and the money through the wallet provider
 * seam, which only a Fintava server can use for a bill (the fee quote refuses
 * a bill under Nuvion).
 */
@Module({
  imports: [
    WawuAuthModule,
    MoneyModule,
    LedgerModule,
    FintavaModule,
    WalletProviderModule,
    BillsCatalogueModule,
  ],
  controllers: [WalletBillsController],
  providers: [WalletBillService],
})
export class WalletBillsModule {}
