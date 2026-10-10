import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { WaitlistAdminController } from './waitlist-admin.controller';
import { WaitlistCoreModule } from './waitlist-core.module';
import { WaitlistPublicController } from './waitlist-public.controller';
import { WaitlistSweepService } from './waitlist-sweep.service';

/**
 * The event registration link (JOIN-01, R-48): register on the website, pay
 * the event fee by Flutterwave checkout, no account. This module declares the
 * routes and the sweeps; the service itself is WaitlistCoreModule's.
 *
 * The offer comes from PLANS_CONFIG (`event_offers` in plans.config.json,
 * checked at boot by the plans schema check). The Flutterwave client is
 * ContentPieceModule's FLUTTERWAVE_CLIENT, the one the tick purchase uses,
 * so there is one idiom and one place the mock/real swap is decided
 * (`shouldUseMockFlutterwave`, which refuses a production boot without a
 * real key). AdminAuthModule gives the admin routes their guards.
 *
 * Listed in AppModule after PlansModule; it imports nothing that declares a
 * controller other than AdminAuthModule (already early), so no other route
 * moves in the order.
 */
@Module({
  imports: [AdminAuthModule, WaitlistCoreModule],
  controllers: [WaitlistPublicController, WaitlistAdminController],
  providers: [WaitlistSweepService],
})
export class WaitlistModule {}
