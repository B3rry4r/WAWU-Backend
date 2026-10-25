import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { LegalFeeWalletController } from './legal-fee-wallet.controller';
import { LegalFeeWalletService } from './legal-fee-wallet.service';
import { LegalMatterNoticeService } from '../legal-matter-notice.service';

/**
 * Paying legal fees from the wallet (task LEGAL-05): the routes under
 * `legal/requests/:id/pay/wallet` and the `legal_fee` payment kind registered
 * with MONEY-17's pay from wallet. It sits beside LegalModule, not in it, so
 * the web's Flutterwave legal payments and the specs that import LegalModule
 * do not need the wallet provider's settings to boot.
 *
 * Mounting it in AppModule is SHARED-CHANGES LEGAL-05 #1 (one import and one
 * entry).
 */
@Module({
  imports: [WawuAuthModule, MoneyModule],
  controllers: [LegalFeeWalletController],
  providers: [LegalFeeWalletService, LegalMatterNoticeService],
})
export class LegalFeeWalletModule {}
