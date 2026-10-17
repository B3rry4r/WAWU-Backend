import { Module } from '@nestjs/common';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import {
  FlutterwaveReferenceLookup,
  WAITLIST_PAYMENT_LOOKUP,
} from './waitlist-payment-lookup';
import { systemRandom, WAITLIST_RANDOM } from './waitlist-random';
import { ReferralService } from './referral/referral.service';
import { WaitlistService } from './waitlist.service';

/**
 * The event registration link's service, with no routes (JOIN-01).
 *
 * Split from WaitlistModule so the Flutterwave webhook (PaymentWebhookModule)
 * can settle a registration without importing the module that declares the
 * routes. AdminPaymentsModule, which AppModule lists early, imports
 * PaymentWebhookModule; if that imported WaitlistModule (or PlansModule)
 * their controllers would be registered at that early point instead of where
 * AppModule lists them, and `plans`, `me/tier` and `waitlist` would move in
 * the route order. This module declares no controller, so importing it moves
 * nothing.
 *
 * The plan comes from PlanSettingsModule rather than from importing
 * PlansModule (which declares `GET /plans` and `GET /me/tier`): the same live
 * plan under one provider token (TIER-06), so a spec that overrides
 * PLANS_CONFIG overrides both. PlanSettingsModule declares no controller. ContentPieceModule is already early in
 * AppModule, so importing it here moves nothing either.
 */
@Module({
  imports: [ContentPieceModule, PlanSettingsModule],
  providers: [
    { provide: WAITLIST_RANDOM, useValue: systemRandom },
    ReferralService,
    WaitlistService,
    { provide: WAITLIST_PAYMENT_LOOKUP, useClass: FlutterwaveReferenceLookup },
  ],
  exports: [WaitlistService],
})
export class WaitlistCoreModule {}
