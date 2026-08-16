import { Module } from '@nestjs/common';
import { DmReportController } from './dm-report.controller';
import { DmReportService } from './dm-report.service';

@Module({
  controllers: [DmReportController],
  providers: [DmReportService],
})
export class DmReportModule {}
