import { Module } from '@nestjs/common';
import { IdentityPauseModule } from '../money/opening/identity-pause.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PointsModule } from '../points/points.module';
import { BillingCurrencyService } from './billing-currency.service';
import { HostTierOffersInterceptor } from './host-tier-offers.interceptor';
import { MakerTierService } from './maker-tier.service';
import { MeTierController } from './me-tier.controller';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { PublishingAllowanceService } from './publishing-allowance.service';
import { PublishingGate } from './publishing-gate.service';
import { PublishingOffersInterceptor } from './publishing-offers.interceptor';
import { TierGrantService } from './tier-grant.service';

/**
 * The maker plan (TIER-01, R-43): its figures from `plans.config.json`,
 * checked at boot (a bad file stops the server naming the field), with the
 * settings an admin saved laid over them (TIER-06, R-65: PlanSettingsModule
 * provides PLANS_CONFIG as the live plan), a person's billing currency, and
 * the one reader of their tier.
 *
 * The publishing gate (TIER-02): `PublishingAllowanceService` says what a
 * person may publish and has used, `PublishingGate` refuses with a 402 when
 * they may not, and `PublishingOffersInterceptor` (on the routes that carry
 * `@GatesPublishing()`) adds the offers to that refusal.
 *
 * Exported for the tasks that build on it: the gate and the places that show
 * what a person may publish read the allowance; the purchases (TIER-03,
 * TIER-04, POINTS-02) price from PLANS_CONFIG with `priceIn` and fix the
 * currency with BillingCurrencyService.fixAtFirstPurchase. TierGrantService
 * is the one place a tier, its event pass and its bonus points are granted
 * (the purchase and the event-registration claim both call it); it needs
 * PointsService, so PointsModule is imported, and it is already mounted ahead
 * of this module by MeModule, so no route moves.
 *
 * Hosting an event reads the tier too (EVENTS-12): `HostTierOffersInterceptor`
 * (on the routes that carry `@GatesHosting()`) adds the lowest tier to the 403
 * `tier_required` that EventService.assertMayHost throws.
 *
 * The gate also refuses while the person's identity check is paused (S7
 * round 2, F3): `IdentityPauseModule` gives it the reader.
 *
 * PrismaService comes from the global PrismaModule, as for every module.
 */
@Module({
  imports: [PointsModule, PlanSettingsModule, IdentityPauseModule],
  controllers: [PlansController, MeTierController],
  providers: [
    BillingCurrencyService,
    HostTierOffersInterceptor,
    MakerTierService,
    PlansService,
    PublishingAllowanceService,
    PublishingGate,
    PublishingOffersInterceptor,
    TierGrantService,
  ],
  exports: [
    // Re-exports PLANS_CONFIG (the live plan) and PlanSettingsService.
    PlanSettingsModule,
    BillingCurrencyService,
    HostTierOffersInterceptor,
    MakerTierService,
    PlansService,
    PublishingAllowanceService,
    PublishingGate,
    PublishingOffersInterceptor,
    TierGrantService,
  ],
})
export class PlansModule {}
