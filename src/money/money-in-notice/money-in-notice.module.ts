import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NoticeMailModule } from '../../notice-mail/notice-mail.module';
import { NotificationModule } from '../../notification/notification.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { MoneyInNoticeService } from './money-in-notice.service';

/**
 * Money in, told once (task WALLET-10): the sweep that turns a credited
 * ledger row into one `money_in` notification. No route. Imported by
 * MoneyModule; its @Interval runs where ScheduleModule.forRoot() is loaded
 * (AppModule). The provider is reached only through WalletProviderModule
 * (MONEY-20), and the notification only through NotificationService.emit().
 */
@Module({
  imports: [
    ConfigModule,
    WalletProviderModule,
    NotificationModule,
    NoticeMailModule,
  ],
  providers: [MoneyInNoticeService],
  exports: [MoneyInNoticeService],
})
export class MoneyInNoticeModule {}
