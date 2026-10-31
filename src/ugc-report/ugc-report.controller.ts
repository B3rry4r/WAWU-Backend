import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreateUgcReportDto } from './dto/create-ugc-report.dto';
import { UgcReportService, type UgcReportView } from './ugc-report.service';

/**
 * REPORT-UGC. `POST /reports` reports a piece, a comment, a profile, a community message, a chat message or a paid
 * question. Any signed-in person (either account type). Every new report is also mailed to support, so the service
 * holds a person to 30 new reports an hour on top of the Hub's global limits.
 */
@Controller('reports')
@UseGuards(WawuAuthGuard)
export class UgcReportController {
  constructor(private readonly reports: UgcReportService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  report(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateUgcReportDto,
  ): Promise<UgcReportView> {
    return this.reports.create(user.sub, dto);
  }
}
