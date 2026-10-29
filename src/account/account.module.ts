import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDeletionIdentityService } from './account-deletion-identity.service';
import { AccountDeletionMoneyService } from './account-deletion-money.service';
import { AccountDeletionSweepService } from './account-deletion-sweep.service';
import { WAWU_ID_ACCOUNT_GATEWAY } from './wawu-id-account.gateway';
import { WawuIdAccountClient } from './wawu-id-account.client';
import { PushModule } from '../push/push.module';
import { PointsModule } from '../points/points.module';
import { AccountPurgeModule } from '../account-purge/account-purge.module';
import { IdDocsRetentionModule } from '../account-purge/id-docs-retention.module';
import { WalletProviderModule } from '../wallet-provider/wallet-provider.module';
import { NoticeMailModule } from '../notice-mail/notice-mail.module';

@Module({
  imports: [
    // EMAIL-02: the deletion emails.
    NoticeMailModule,
    // INBOX-03: a deletion asked for forgets the person's phones at once.
    PushModule,
    // SETTINGS-06: the wallet is looked at and frozen through the provider
    // seam; the sweep releases held points and deletes the account's data.
    WalletProviderModule,
    PointsModule,
    AccountPurgeModule,
    // SETTINGS-09: the daily sweep that deletes the ID documents kept for the
    // days in the admin setting `id_docs_keep_days` (R-73).
    IdDocsRetentionModule,
  ],
  controllers: [AccountController],
  providers: [
    AccountService,
    AccountDeletionMoneyService,
    // SETTINGS-08: tells WAWU ID the deletion started, until it confirms.
    AccountDeletionIdentityService,
    AccountDeletionSweepService,
    { provide: WAWU_ID_ACCOUNT_GATEWAY, useClass: WawuIdAccountClient },
  ],
})
export class AccountModule {}
