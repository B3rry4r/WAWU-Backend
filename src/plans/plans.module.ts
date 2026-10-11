import { Module } from '@nestjs/common';
import { PointsModule } from '../points/points.module';
import { BillingCurrencyService } from './billing-currency.service';
import { MakerTierService } from './maker-tier.service';
import { MeTierController } from './me-tier.controller';
import { loadPlansConfig, PLANS_CONFIG } from './plans-config';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { TierGrantService } from './tier-grant.service';

/**
 * The maker plan (TIER-01, R-43): its figures from `plans.config.json`,
 * checked at boot (a bad file stops the server naming the field), a
 * person's billing currency, and the one reader of their tier.
 *
 * Exported for the tasks that build on it: the publishing gate (TIER-02)
 * asks MakerTierService; the purchases (TIER-03, TIER-04, POINTS-02) price
 * from PLANS_CONFIG with `priceIn` and fix the currency with
 * BillingCurrencyService.fixAtFirstPurchase. TierGrantService is the one
 * place a tier, its event pass and its bonus points are granted (the purchase
 * and the event-registration claim both call it); it needs PointsService, so
 * PointsModule is imported, and it is already mounted ahead of this module by
 * MeModule, so no route moves.
 *
 * PrismaService comes from the global PrismaModule, as for every module.
 */
@Module({
  imports: [PointsModule],
  controllers: [PlansController, MeTierController],
  providers: [
    { provide: PLANS_CONFIG, useFactory: () => loadPlansConfig() },
    BillingCurrencyService,
    MakerTierService,
    PlansService,
    TierGrantService,
  ],
  exports: [
    PLANS_CONFIG,
    BillingCurrencyService,
    MakerTierService,
    PlansService,
    TierGrantService,
  ],
})
export class PlansModule {}
