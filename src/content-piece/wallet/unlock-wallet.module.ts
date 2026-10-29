import { NoticeMailModule } from '../../notice-mail/notice-mail.module';
import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { StorageModule } from '../../storage/storage.module';
import { UnlockWalletController } from './unlock-wallet.controller';
import { UnlockWalletService } from './unlock-wallet.service';

/**
 * Unlocking content from the wallet (task HOME-15): the routes under
 * `content/:id/unlock/wallet` and the `content_unlock` payment kind
 * registered with MONEY-17's pay from wallet. It sits beside
 * ContentPieceModule, not in it, so the web's Flutterwave unlock and the
 * specs that import ContentPieceModule do not need the wallet provider's
 * settings to boot.
 *
 * Mounting it in AppModule is SHARED-CHANGES HOME-15 #1 (one import and one
 * entry).
 */
@Module({
  imports: [
    NoticeMailModule,
    WawuAuthModule,
    MoneyModule,
    BlockedAccountModule,
    StorageModule,
  ],
  controllers: [UnlockWalletController],
  providers: [UnlockWalletService],
})
export class UnlockWalletModule {}
