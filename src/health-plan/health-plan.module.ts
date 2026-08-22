import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { WellaHealthClient } from './wellahealth.client';
import { HealthPlanService } from './health-plan.service';
import { HealthPlanController } from './health-plan.controller';
import { HealthPlanOpsController } from './health-plan-ops.controller';

@Module({
  imports: [PrismaModule],
  controllers: [HealthPlanController, HealthPlanOpsController],
  providers: [HealthPlanService, WellaHealthClient, FlutterwaveCheckoutVerifier],
  exports: [HealthPlanService],
})
export class HealthPlanModule {}
