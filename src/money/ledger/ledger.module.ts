import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FintavaModule } from '../../fintava/fintava.module';
import { LedgerConsumerService } from './ledger-consumer.service';
import { LedgerService } from './ledger.service';

/**
 * The ledger (task MONEY-10): WAWU's record of every movement of money on
 * the Fintava wallets it knows, in kobo, fed from MONEY-07's stored
 * deliveries by a sweep (LedgerConsumerService) and reconciled with Fintava
 * through the MONEY-06 client. No route: the history routes are MONEY-15's.
 *
 * LedgerService is exported for the features that move money (WALLET-07,
 * WALLET-09, MONEY-17, MONEY-18) to record their own sends, and
 * LedgerConsumerService for MONEY-08's pending sweep (`reconcileEntry`).
 * The sweep's @Cron runs only where ScheduleModule.forRoot() is loaded
 * (AppModule); without FINTAVA_* settings it reads the database and sends
 * nothing to Fintava.
 */
@Module({
  imports: [ConfigModule, FintavaModule],
  providers: [LedgerService, LedgerConsumerService],
  exports: [LedgerService, LedgerConsumerService],
})
export class LedgerModule {}
