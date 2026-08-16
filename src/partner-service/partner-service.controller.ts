import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PartnerServiceService } from './partner-service.service';
import type { PartnerService } from '../common/types';

/**
 * registry.json § PartnerService — all three endpoints are `roles: ["any"]`,
 * i.e. any authenticated WAWU user (conventions.md § Roles & permissions
 * guard idiom — `@UseGuards(WawuAuthGuard)` for "any authenticated user").
 * Data is reference/seed data, admin-managed later — no write endpoints
 * beyond the notify-me stub exist here by contract.
 */
@UseGuards(WawuAuthGuard)
@Controller('services')
export class PartnerServiceController {
  constructor(private readonly partnerServiceService: PartnerServiceService) {}

  @Get()
  list(): Promise<PartnerService[]> {
    return this.partnerServiceService.list();
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<PartnerService> {
    return this.partnerServiceService.findOne(id);
  }

  @Post(':id/notify-me')
  @HttpCode(HttpStatus.OK)
  notifyMe(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ success: true }> {
    return this.partnerServiceService.notifyMe(id);
  }
}
