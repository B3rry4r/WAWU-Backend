import { Module } from '@nestjs/common';
import { LearnEntitlementController } from './learn-entitlement.controller';
import { LearnEntitlementService } from './learn-entitlement.service';

@Module({
  controllers: [LearnEntitlementController],
  providers: [LearnEntitlementService],
})
export class LearnEntitlementModule {}
