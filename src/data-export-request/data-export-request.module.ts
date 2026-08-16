import { Module } from '@nestjs/common';
import { DataExportRequestController } from './data-export-request.controller';
import { DataExportRequestService } from './data-export-request.service';

@Module({
  controllers: [DataExportRequestController],
  providers: [DataExportRequestService],
})
export class DataExportRequestModule {}
