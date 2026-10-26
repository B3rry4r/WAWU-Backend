import { Module } from '@nestjs/common';
import { AboutController } from './about.controller';
import { AboutSettings } from './about-settings';
import { PoliciesService } from './policies.service';
import { PolicyAcceptanceController } from './policy-acceptance.controller';
import { PolicyAcceptanceService } from './policy-acceptance.service';

@Module({
  controllers: [AboutController, PolicyAcceptanceController],
  providers: [AboutSettings, PoliciesService, PolicyAcceptanceService],
  exports: [PoliciesService],
})
export class AboutModule {}
