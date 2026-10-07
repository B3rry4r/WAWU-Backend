import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { LedgerConsumerService } from './ledger-consumer.service';
import { LedgerStatusService } from './ledger-status.service';
import { LedgerService } from './ledger.service';

/**
 * The ledger (task MONEY-10): WAWU's record of every movement of money on
 * the Fintava wallets it knows, in kobo, fed from MONEY-07's stored
 * deliveries by a sweep (LedgerConsumerService) and reconciled with Fintava
 * through the MONEY-06 client. No route: the history routes are MONEY-15's.
 *
 * LedgerService is exported for the features that move money (WALLET-07,
 * WALLET-09, MONEY-17, MONEY-18) to record their own sends, and
 * LedgerConsumerService, whose `reconcileEntry` now calls MONEY-08's check.
 * The sweep's @Cron runs only where ScheduleModule.forRoot() is loaded
 * (AppModule); without FINTAVA_* settings it reads the database and sends
 * nothing to Fintava.
 *
 * MONEY-08: LedgerStatusService, the pending sweep. Every minute it asks
 * Fintava how `pending` rows older than two minutes ended, when their
 * webhook has not said, and settles them; it never sends money. Exported
 * for the sending features (WALLET-09) to check a send before any retry.
 *
 * MONEY-20: the provider is reached through WalletProviderModule
 * (`WALLET_PROVIDER`), never a provider's module or client.
 */
@Module({
  imports: [ConfigModule, WalletProviderModule],
  providers: [LedgerService, LedgerConsumerService, LedgerStatusService],
  exports: [LedgerService, LedgerConsumerService, LedgerStatusService],
})
export class LedgerModule {}
