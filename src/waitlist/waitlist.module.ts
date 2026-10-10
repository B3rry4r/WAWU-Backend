import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { PlansModule } from '../plans/plans.module';
import { WaitlistAdminController } from './waitlist-admin.controller';
import {
  FlutterwaveReferenceLookup,
  WAITLIST_PAYMENT_LOOKUP,
} from './waitlist-payment-lookup';
import { WaitlistPublicController } from './waitlist-public.controller';
import { WaitlistSweepService } from './waitlist-sweep.service';
import { WaitlistService } from './waitlist.service';

/**
 * The event registration link (JOIN-01, R-48): register on the website, pay
 * the event fee by Flutterwave checkout, no account.
 *
 * The offer comes from PLANS_CONFIG (`event_offers` in plans.config.json,
 * checked at boot by the plans schema check). The Flutterwave client is
 * ContentPieceModule's FLUTTERWAVE_CLIENT, the one the tick purchase uses,
 * so there is one idiom and one place the mock/real swap is decided
 * (`shouldUseMockFlutterwave`, which refuses a production boot without a
 * real key). AdminAuthModule gives the admin routes their guards.
 *
 * WaitlistService is exported for the Flutterwave webhook
 * (PaymentWebhookService) and for JOIN-03's claim in the app.
 *
 * Listed in AppModule after PlansModule and ContentPieceModule so that
 * importing them here moves no other controller in the route order.
 */
@Module({
  imports: [AdminAuthModule, ContentPieceModule, PlansModule],
  controllers: [WaitlistPublicController, WaitlistAdminController],
  providers: [
    WaitlistService,
    WaitlistSweepService,
    { provide: WAITLIST_PAYMENT_LOOKUP, useClass: FlutterwaveReferenceLookup },
  ],
  exports: [WaitlistService],
})
export class WaitlistModule {}
