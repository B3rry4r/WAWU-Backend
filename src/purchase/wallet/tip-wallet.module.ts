import { NoticeMailModule } from '../../notice-mail/notice-mail.module';
import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { TipWalletController } from './tip-wallet.controller';
import { TipWalletService } from './tip-wallet.service';

/**
 * Tipping from the wallet (task HOME-14): the routes under `tips/wallet` and
 * the `tip` payment kind registered with MONEY-17's pay from wallet. It sits
 * beside PurchaseModule, not in it, so the web's Flutterwave tip and the
 * specs that import PurchaseModule do not need the wallet provider's
 * settings to boot.
 *
 * Mounting it in AppModule is SHARED-CHANGES HOME-14 #1 (one import and one
 * entry).
 */
@Module({
  imports: [
    NoticeMailModule,
    WawuAuthModule,
    MoneyModule,
    BlockedAccountModule,
  ],
  controllers: [TipWalletController],
  providers: [TipWalletService],
})
export class TipWalletModule {}
