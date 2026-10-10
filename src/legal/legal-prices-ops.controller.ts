import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { LegalPricesService } from './legal-prices.service';
import {
  SetConsultationPriceDto,
  SetServicePriceDto,
} from './dto/legal-consultation.dto';
import type {
  AdminConsultationPriceView,
  AdminLegalPricesView,
  AdminServicePriceView,
} from './legal-consultation.types';
import type { ConsultationMediumId } from './legal-catalogue';

/** The values `:medium` may take, as the pipe wants them. */
const MEDIA = {
  chat: 'chat',
  zoom: 'zoom',
  phone: 'phone',
  physical: 'physical',
} as const;

/**
 * The legal prices WAWU sets in admin (LEGAL-03, R-14): what each kind of
 * consultation costs and how long it runs, and the price of each fixed-price
 * service. The app and the web both read these; nothing in code holds a price.
 *
 * ── ROLE MATRIX (enforced per handler) ────────────────────────────────────
 *   read           superadmin, support, finance
 *   set a price    superadmin, finance
 *   reviewer       refused
 *
 * Setting a price is a money decision, the same call as quoting a matter
 * (`POST /legal/ops/requests/:id/quote`), so it sits with the same roles.
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every
 * handler names its roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('legal/ops/prices')
export class LegalPricesOpsController {
  constructor(private readonly prices: LegalPricesService) {}

  /** Every consultation kind and every fixed-price service, set or not. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support, AdminRole.finance)
  @Get()
  list(): Promise<AdminLegalPricesView> {
    return this.prices.adminView();
  }

  /** Sets one kind of consultation: its price, its length and its switch. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Put('consultations/:medium')
  @HttpCode(HttpStatus.OK)
  setConsultation(
    @Param('medium', new ParseEnumPipe(MEDIA)) medium: ConsultationMediumId,
    @Body() dto: SetConsultationPriceDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<AdminConsultationPriceView> {
    return this.prices.setConsultation(admin, medium, dto);
  }

  /** Sets, or with a null price clears, the fixed price of a service. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Put('services/:serviceCode')
  @HttpCode(HttpStatus.OK)
  setService(
    @Param('serviceCode') serviceCode: string,
    @Body() dto: SetServicePriceDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<AdminServicePriceView> {
    return this.prices.setServicePrice(admin, serviceCode, dto);
  }
}
