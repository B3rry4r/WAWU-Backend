import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountPurgeService } from './account-purge.service';
import { UnpaidAccountReaperService } from './unpaid-account-reaper.service';
import { WawuIdAccountClient } from '../account/wawu-id-account.client';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../account/wawu-id-account.gateway';

/**
 * Deleting an account's data, and the sweep that decides an unpaid creator
 * signup has run out of time. Kept out of SchedulerModule deliberately: this
 * is the only scheduled job in the codebase that destroys data, and it should
 * be obvious in the module list rather than folded in with refunds.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    AccountPurgeService,
    UnpaidAccountReaperService,
    { provide: WAWU_ID_ACCOUNT_GATEWAY, useClass: WawuIdAccountClient },
  ],
  exports: [AccountPurgeService],
})
export class AccountPurgeModule {}
