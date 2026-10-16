import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ADS_CLOCK, systemClock } from './ads-clock';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';

/**
 * Serving sponsored cards (task ADS-04). PrismaService comes from the global
 * PrismaModule; WawuAuthModule supplies the sign-in guard. The admin half
 * (ADS-06) and the counting half (ADS-05) are separate modules.
 */
@Module({
  imports: [WawuAuthModule, BlockedAccountModule],
  controllers: [AdsController],
  providers: [AdsService, { provide: ADS_CLOCK, useValue: systemClock }],
  exports: [AdsService],
})
export class AdsModule {}
