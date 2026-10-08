import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { MoneyLimitSettings } from './money-limit-config';
import { MoneyLimits } from './money-limits.service';

/**
 * WAWU's limits on moving money, and the check before any movement
 * (task NUV-07). A module that serves a money-moving route imports this one
 * and calls `MoneyLimits.assertMayMove()` in the transaction that writes the
 * movement's pending ledger row, before the provider is called, leaving that
 * transaction at READ COMMITTED, Prisma's default (any other level is
 * refused; mobile repo BACKEND_GAPS G-410). It needs nothing from
 * MoneyModule, so MoneyModule can import it. PrismaModule is global.
 *
 * Its settings are read, and a bad one stops the app, wherever this module
 * is mounted.
 */
@Module({
  imports: [ConfigModule, WalletProviderModule],
  providers: [MoneyLimitSettings, MoneyLimits],
  exports: [MoneyLimitSettings, MoneyLimits],
})
export class MoneyLimitsModule {}
