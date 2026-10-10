import { Module } from '@nestjs/common';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { loadPlansConfig, PLANS_CONFIG } from '../plans/plans-config';
import {
  FlutterwaveReferenceLookup,
  WAITLIST_PAYMENT_LOOKUP,
} from './waitlist-payment-lookup';
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
 * The plans file is read here again rather than by importing PlansModule
 * (which declares `GET /plans` and `GET /me/tier`): the same file, checked by
 * the same schema check, and one provider token, so a spec that overrides
 * PLANS_CONFIG overrides both. ContentPieceModule is already early in
 * AppModule, so importing it here moves nothing either.
 */
@Module({
  imports: [ContentPieceModule],
  providers: [
    { provide: PLANS_CONFIG, useFactory: () => loadPlansConfig() },
    WaitlistService,
    { provide: WAITLIST_PAYMENT_LOOKUP, useClass: FlutterwaveReferenceLookup },
  ],
  exports: [WaitlistService],
})
export class WaitlistCoreModule {}
