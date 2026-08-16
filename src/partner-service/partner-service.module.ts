import { Module } from '@nestjs/common';
import { PartnerServiceController } from './partner-service.controller';
import { PartnerServiceService } from './partner-service.service';

@Module({
  controllers: [PartnerServiceController],
  providers: [PartnerServiceService],
})
export class PartnerServiceModule {}
