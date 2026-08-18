import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApplyPartnerServiceDto } from './dto/apply-partner.dto';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ServiceApplicationService } from './service-application.service';
import { ApplyCacDto } from './dto/apply-cac.dto';
import { VerifyCacDto } from './dto/verify-cac.dto';
import { ApplyNepcDto } from './dto/apply-nepc.dto';

/**
 * registry.json § ServiceApplication. All five endpoints are `roles: ["any"]`
 * — any authenticated WAWU user, no creator gate. List/get are scoped to the
 * caller's own applications (mirrors MarketplaceSave/SavedItem's
 * self-scoped-by-`user.sub` pattern) — the frozen contract carries no
 * separate "admin view all applications" surface.
 */
@UseGuards(WawuAuthGuard)
@Controller('services')
export class ServiceApplicationController {
  constructor(private readonly serviceApplicationService: ServiceApplicationService) {}

  @Get('applications')
  list(@CurrentUser() user: WawuJwtClaims, @Query() query: PaginationQueryDto) {
    return this.serviceApplicationService.list(user.sub, query.page, query.perPage);
  }

  @Get('applications/:id')
  getById(@CurrentUser() user: WawuJwtClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.serviceApplicationService.getById(user.sub, id);
  }

  @Post('cac/apply')
  applyCac(@CurrentUser() user: WawuJwtClaims, @Body() dto: ApplyCacDto) {
    return this.serviceApplicationService.applyCac(user.sub, dto);
  }

  @Post('cac/apply/verify')
  verifyCac(@CurrentUser() user: WawuJwtClaims, @Body() dto: VerifyCacDto) {
    return this.serviceApplicationService.verifyCac(user.sub, dto);
  }

  /** The carried-over partner services: Pension, Banking, Grants. */
  @Post('partner/apply')
  @HttpCode(HttpStatus.CREATED)
  applyPartner(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ApplyPartnerServiceDto,
  ) {
    return this.serviceApplicationService.applyForPartnerService(user.sub, dto);
  }

  @Post('nepc/apply')
  applyNepc(@CurrentUser() user: WawuJwtClaims, @Body() dto: ApplyNepcDto) {
    return this.serviceApplicationService.applyNepc(user.sub, dto);
  }
}
