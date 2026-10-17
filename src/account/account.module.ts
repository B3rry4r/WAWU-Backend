import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDeletionMoneyService } from './account-deletion-money.service';
import { AccountDeletionSweepService } from './account-deletion-sweep.service';
import { WAWU_ID_ACCOUNT_GATEWAY } from './wawu-id-account.gateway';
import { WawuIdAccountClient } from './wawu-id-account.client';
import { PushModule } from '../push/push.module';
import { PointsModule } from '../points/points.module';
import { AccountPurgeModule } from '../account-purge/account-purge.module';
import { WalletProviderModule } from '../wallet-provider/wallet-provider.module';

@Module({
  imports: [
    // INBOX-03: a deletion asked for forgets the person's phones at once.
    PushModule,
    // SETTINGS-06: the wallet is looked at and frozen through the provider
    // seam; the sweep releases held points and deletes the account's data.
    WalletProviderModule,
    PointsModule,
    AccountPurgeModule,
  ],
  controllers: [AccountController],
  providers: [
    AccountService,
    AccountDeletionMoneyService,
    AccountDeletionSweepService,
    { provide: WAWU_ID_ACCOUNT_GATEWAY, useClass: WawuIdAccountClient },
  ],
})
export class AccountModule {}
