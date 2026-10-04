import { Module } from '@nestjs/common';
import { DataExportRequestController } from './data-export-request.controller';
import { DataExportDownloadController } from './data-export-download.controller';
import { DataExportRequestService } from './data-export-request.service';
import { DataExportBuilder } from './data-export-builder.service';
import { DataExportFulfilmentService } from './data-export-fulfilment.service';
import { DataExportMailer } from './data-export-mailer';

@Module({
  controllers: [DataExportRequestController, DataExportDownloadController],
  providers: [
    DataExportRequestService,
    DataExportBuilder,
    DataExportFulfilmentService,
    DataExportMailer,
  ],
  exports: [DataExportFulfilmentService],
})
export class DataExportRequestModule {}
