import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { PointsModule } from '../../points/points.module';
import { PlansModule } from '../plans.module';
import { PlanPurchasesController } from './plan-purchases.controller';
import { PlanPurchaseService } from './plan-purchase.service';

/**
 * Buying, renewing and upgrading a tier from the wallet (task TIER-03): the
 * routes under `plans/purchases` and the two payment kinds (`tier`,
 * `tier_bump`) registered with MONEY-17's pay from wallet. It sits beside
 * PlansModule, not in it, so the specs and the modules that import PlansModule
 * for its prices and TierGrantService (the maker plan, JOIN-03's claim) do not
 * need the wallet provider's settings to boot.
 *
 * Mounting it in AppModule is SHARED-CHANGES TIER-03 #1 (one import and one
 * entry, after PlansModule).
 */
@Module({
  imports: [WawuAuthModule, MoneyModule, PlansModule, PointsModule],
  controllers: [PlanPurchasesController],
  providers: [PlanPurchaseService],
})
export class PlanPurchasesModule {}
