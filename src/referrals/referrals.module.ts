import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PointsModule } from '../points/points.module';
import { ReferralRewardService } from './referral-reward.service';
import { ReferralSweepService } from './referral-sweep.service';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * Invite and earn (task REF-02, R-43, R-65): `GET /me/referrals`, `POST
 * /me/referrals/claim`, the reward a first paid tier makes, and the job that
 * pays it after the hold. The reward is points through POINTS-01, never
 * cash; no provider, no money.
 *
 * MeModule imports it (so AppModule is not edited, as for POINTS-01) and the
 * tier purchase imports it for `ReferralRewardService.onTierPaid`.
 */
@Module({
  imports: [WawuAuthModule, PointsModule, PlanSettingsModule],
  controllers: [ReferralsController],
  providers: [ReferralsService, ReferralRewardService, ReferralSweepService],
  exports: [ReferralRewardService],
})
export class ReferralsModule {}
