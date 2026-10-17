import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { CreditWalletController } from './credit-wallet.controller';
import { CreditWalletService } from './credit-wallet.service';

/**
 * Buying WAWU Credits from the wallet (task INBOX-16): the routes under
 * `credits/packs` and `credits/purchase/wallet`, and the `credit_pack` payment
 * kind registered with MONEY-17's pay from wallet. It sits beside
 * CreditPurchaseModule, not in it, so the web's Flutterwave purchase, the
 * payment webhook and the specs that import CreditPurchaseModule do not need
 * the wallet provider's settings to boot.
 *
 * Mounting it in AppModule is SHARED-CHANGES INBOX-16 #1 (one import and one
 * entry, after WalletBillsModule).
 */
@Module({
  imports: [WawuAuthModule, MoneyModule],
  controllers: [CreditWalletController],
  providers: [CreditWalletService],
})
export class CreditWalletModule {}
