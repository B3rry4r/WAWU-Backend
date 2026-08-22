import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminOpsAuditModule } from '../common/audit/admin-ops-audit.module';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { LegalRequestsService } from './legal.service';
import { LegalController } from './legal.controller';
import { LegalOpsController } from './legal-ops.controller';

/**
 * AdminAuthModule is imported for its two exported GUARDS only — nothing else
 * in it is used here, and it registers no route this module owns.
 * LegalOpsController used to sit behind AdminKeyGuard (one shared static
 * secret, no identity, no roles); it now sits behind AdminAuthGuard +
 * AdminRolesGuard, the same pair the admin KYC and content queues use.
 *
 * Importing it HERE rather than wiring anything in app.module.ts is
 * deliberate: AdminAuthModule is already registered there, Nest dedupes
 * module instances, and route-registration order — which app.module.ts
 * documents at length as load-bearing — is therefore untouched.
 */
@Module({
  imports: [PrismaModule, AdminAuthModule, AdminOpsAuditModule],
  controllers: [LegalController, LegalOpsController],
  providers: [LegalRequestsService, FlutterwaveCheckoutVerifier],
  exports: [LegalRequestsService],
})
export class LegalModule {}
