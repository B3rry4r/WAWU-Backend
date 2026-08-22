import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminOpsAuditModule } from '../common/audit/admin-ops-audit.module';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { WellaHealthClient } from './wellahealth.client';
import { HealthPlanService } from './health-plan.service';
import { HealthPlanController } from './health-plan.controller';
import { HealthPlanOpsController } from './health-plan-ops.controller';

/**
 * AdminAuthModule is imported for its two exported GUARDS only.
 * HealthPlanOpsController moved off
 * AdminKeyGuard (one shared static secret, no identity, no roles) onto
 * AdminAuthGuard + AdminRolesGuard. Imported here rather than wired in
 * app.module.ts so the documented, load-bearing route-registration order in
 * that file is untouched — Nest dedupes the already-registered module.
 */
@Module({
  imports: [PrismaModule, AdminAuthModule, AdminOpsAuditModule],
  controllers: [HealthPlanController, HealthPlanOpsController],
  providers: [HealthPlanService, WellaHealthClient, FlutterwaveCheckoutVerifier],
  exports: [HealthPlanService],
})
export class HealthPlanModule {}
