import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PlanSettingsModule } from '../../../plan-settings/plan-settings.module';
import { MoneyCheckMailer } from '../../check/money-check-mailer';
import { FeeRecordService } from './fee-record.service';
import { FeeScheduleService } from './fee-schedule.service';
import { ProviderRateService } from './provider-rate.service';

/**
 * The fee engine (FEE-01, R-139): WAWU's fee schedule, the provider's rates
 * and the per-transaction fee record. Needs nothing from MoneyModule, so
 * MoneyModule and MoneyLimitsModule can both import it. PrismaModule is global.
 */
@Module({
  imports: [ConfigModule, PlanSettingsModule],
  providers: [
    FeeScheduleService,
    ProviderRateService,
    FeeRecordService,
    MoneyCheckMailer,
  ],
  exports: [FeeScheduleService, ProviderRateService, FeeRecordService],
})
export class FeeEngineModule {}
