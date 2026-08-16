import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { DmReportService } from './dm-report.service';
import { CreateDmReportDto } from './dto/create-dm-report.dto';
import type { DmReport } from '../common/types';

/**
 * registry.json § DmReport — a single endpoint off the messages-dm screen:
 * "report this DM thread". Roles: "any" (any authenticated WAWU user, either
 * account type — a fan reporting a creator's DM or vice versa), so only the
 * base WawuAuthGuard applies, no creator-gate check, per conventions.md §
 * Roles & permissions.
 */
@Controller('dm')
@UseGuards(WawuAuthGuard)
export class DmReportController {
  constructor(private readonly dmReportService: DmReportService) {}

  @Post(':messageId/report')
  @HttpCode(HttpStatus.CREATED)
  async report(
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() _body: CreateDmReportDto,
  ): Promise<DmReport> {
    return this.dmReportService.create(messageId, user.sub);
  }
}
