import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PointsController } from './points.controller';
import { PointsExpiryService } from './points-expiry.service';
import { PointsService } from './points.service';

/**
 * Points (task POINTS-01): lots that expire, holds, and the append-only
 * ledger, with `GET /me/points` and the expiry job. PointsService is
 * exported for the tasks that grant and spend points (TIER-03, POINTS-02,
 * POINTS-03, POINTS-04, REF-01). No provider, no money: points are a count.
 */
@Module({
  imports: [WawuAuthModule],
  controllers: [PointsController],
  providers: [PointsService, PointsExpiryService],
  exports: [PointsService],
})
export class PointsModule {}
