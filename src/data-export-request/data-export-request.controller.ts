import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { DataExportRequestService } from './data-export-request.service';
import { CreateDataExportRequestDto } from './dto/create-data-export-request.dto';
import type { DataExportRequest } from '../common/types';

/**
 * registry.json § DataExportRequest — a single endpoint off the
 * settings-privacy screen: "request an export of my data". Roles: "any"
 * (any authenticated WAWU user), so only the base WawuAuthGuard applies —
 * no creator-gate check per conventions.md § Roles & permissions.
 */
@Controller('settings/privacy')
@UseGuards(WawuAuthGuard)
export class DataExportRequestController {
  constructor(private readonly dataExportRequestService: DataExportRequestService) {}

  @Post('export')
  @HttpCode(HttpStatus.CREATED)
  async requestExport(
    @CurrentUser() user: WawuJwtClaims,
    @Body() _body: CreateDataExportRequestDto,
  ): Promise<DataExportRequest> {
    return this.dataExportRequestService.create(user.sub);
  }

  /** The caller's own export requests and where each one is (pending, sent, failed). */
  @Get('export')
  async listMine(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<DataExportRequest[]> {
    return this.dataExportRequestService.listMine(user.sub);
  }
}
