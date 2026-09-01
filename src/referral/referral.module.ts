import { Module } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { ReferralController } from './referral.controller';
import { AdminReferralController } from '../admin/referral/admin-referral.controller';
import { AdminReferralService } from '../admin/referral/admin-referral.service';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';

/**
 * Referral codes: the public read side and the admin write side in one module,
 * because they are one feature and share ReferralService. The admin controller
 * carries its own guards, so nothing here is reachable without them.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [ReferralController, AdminReferralController],
  providers: [ReferralService, AdminReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
