import { NoticeMailModule } from '../../notice-mail/notice-mail.module';
import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { NotificationModule } from '../../notification/notification.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { DirectMessageModule } from '../direct-message.module';
import { PaidDmCreatorEarningService } from './paid-dm-creator-earning.service';
import { PaidDmWalletController } from './paid-dm-wallet.controller';
import { PaidDmWalletService } from './paid-dm-wallet.service';

/**
 * Paid questions paid from the wallet (task INBOX-17): `dm/:creatorWawuId/send/wallet`,
 * `dm/send/wallet/pay`, `dm/send/wallet/:questionId/quote` and
 * `dm/send/wallet/:questionId`, and the `paid_dm` payment kind. Every path is
 * a longer literal than the web's Flutterwave routes under `dm` declare.
 */
@Module({
  imports: [
    NoticeMailModule,
    WawuAuthModule,
    MoneyModule,
    BlockedAccountModule,
    NotificationModule,
    WalletProviderModule,
    DirectMessageModule,
  ],
  controllers: [PaidDmWalletController],
  providers: [PaidDmWalletService, PaidDmCreatorEarningService],
})
export class PaidDmWalletModule {}
