import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ADS_CLOCK, systemClock } from './ads-clock';
import { AdsCountsService } from './ads-counts.service';
import { AdsEventsController } from './ads-events.controller';
import { AdsEventsService } from './ads-events.service';

/**
 * Counting views, taps and skips of sponsored cards (task ADS-05). A module of
 * its own, beside AdsModule (serving, ADS-04) and the admin half (ADS-06).
 * PrismaService comes from the global PrismaModule. ADS-06 imports this module
 * to read the counts through AdsCountsService.
 */
@Module({
  imports: [WawuAuthModule],
  controllers: [AdsEventsController],
  providers: [
    AdsEventsService,
    AdsCountsService,
    { provide: ADS_CLOCK, useValue: systemClock },
  ],
  exports: [AdsCountsService],
})
export class AdsEventsModule {}
