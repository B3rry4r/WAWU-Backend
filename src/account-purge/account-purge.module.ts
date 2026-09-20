import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountPurgeService } from './account-purge.service';
import { WawuIdAccountClient } from '../account/wawu-id-account.client';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../account/wawu-id-account.gateway';

/**
 * Deleting an account's data, on request.
 *
 * This module used to also hold UnpaidAccountReaperService, the hourly sweep
 * that destroyed creator accounts which had never bought a subscription. With
 * subscriptions gone there is nothing to buy, so "never paid" became true of
 * every creator account and the sweep would have reaped all of them. It was
 * deleted rather than disabled.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    AccountPurgeService,
    { provide: WAWU_ID_ACCOUNT_GATEWAY, useClass: WawuIdAccountClient },
  ],
  exports: [AccountPurgeService],
})
export class AccountPurgeModule {}
