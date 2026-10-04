import { Module } from '@nestjs/common';
import { AboutController } from './about.controller';
import { AboutSettings } from './about-settings';
import { PoliciesService } from './policies.service';

@Module({
  controllers: [AboutController],
  providers: [AboutSettings, PoliciesService],
  exports: [PoliciesService],
})
export class AboutModule {}
