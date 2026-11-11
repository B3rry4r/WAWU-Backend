import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminRoles } from '../../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../../admin/auth/guards/admin-roles.guard';
import type { AdminUserView } from '../../../admin/auth/admin-user-view.type';
import { BuiltBy } from '../../money-contract';
import {
  AddFeeDto,
  AddProviderRateDto,
  FeeKindsDto,
  FeePreviewDto,
  FeePreviewQueryDto,
  FeeRowDto,
  ProviderRateRowDto,
  ProviderRatesDto,
} from './fee-engine.dto';
import type { FeeKind } from './fee-kinds';
import { FeeScheduleService } from './fee-schedule.service';
import { ProviderRateService } from './provider-rate.service';

/** Kinds where the fee comes off what arrives. */
const TAKEN_OFF_KINDS: readonly FeeKind[] = [
  'intl_wire_in',
  'usd_local_in',
  'ngn_add_money',
  'fx_swap',
];

const WriteRoles = () => AdminRoles(AdminRole.superadmin, AdminRole.finance);
const ReadRoles = () =>
  AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support);

/**
 * WAWU's fee schedule and the provider's rates, for the dashboard (FEE-01,
 * R-139). `/api/hub/admin/money/fees` and `/admin/money/provider-rates`.
 *
 * ── ROLE MATRIX ──────────────────────────────────────────────────────────
 *   fees (read, preview)  superadmin, finance, support
 *   fees (change)         superadmin, finance
 *   provider rates        superadmin, finance only, read and write
 *   reviewer              refused everywhere
 * The provider's rates are confidential: no other role and no app route
 * reads them.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money')
export class AdminFeesController {
  constructor(
    private readonly schedule: FeeScheduleService,
    private readonly rates: ProviderRateService,
  ) {}

  /** Every fee kind: the fee in force, whether its product is on, and its history. */
  @Get('fees')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FEE-01')
  @ReadRoles()
  @ApiOkResponse({ type: FeeKindsDto })
  async fees(): Promise<FeeKindsDto> {
    return { kinds: await this.schedule.kinds() };
  }

  /** Adds a fee row that applies from `startsAt`. Old rows stay in the history. */
  @Post('fees')
  @HttpCode(HttpStatus.CREATED)
  @BuiltBy('FEE-01')
  @WriteRoles()
  @ApiCreatedResponse({ type: FeeRowDto })
  addFee(
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: AddFeeDto,
  ): Promise<FeeRowDto> {
    return this.schedule.add(admin.email, dto);
  }

  /** What a fee would be on an amount, with the fee in force and the VAT setting. */
  @Get('fees/preview')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FEE-01')
  @ReadRoles()
  @ApiOkResponse({ type: FeePreviewDto })
  async preview(@Query() q: FeePreviewQueryDto): Promise<FeePreviewDto> {
    await this.schedule.refresh();
    const amount = BigInt(q.amountMinor);
    const r = this.schedule.feeFor(q.kind as FeeKind, amount, new Date(), q.currency);
    // Lead ruling (FEE-01): money going out adds the fee and VAT on top of
    // the amount; money coming in (a wire, local dollars, adding money) and a
    // swap take them off what arrives.
    const takenOff = TAKEN_OFF_KINDS.includes(q.kind as FeeKind);
    const charges = r.feeMinor + r.vatMinor;
    return {
      feeMinor: Number(r.feeMinor),
      vatMinor: Number(r.vatMinor),
      totalMinor: Number(takenOff ? amount : amount + charges),
      receiveMinor: Number(takenOff ? amount - charges : amount),
      currency: q.currency,
    };
  }

  /** Every provider rate, newest first. Superadmin and finance only. */
  @Get('provider-rates')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FEE-01')
  @WriteRoles()
  @ApiOkResponse({ type: ProviderRatesDto })
  async providerRates(): Promise<ProviderRatesDto> {
    return { rates: await this.rates.list() };
  }

  /** Adds a provider rate row and tells the owner by email. Superadmin and finance only. */
  @Post('provider-rates')
  @HttpCode(HttpStatus.CREATED)
  @BuiltBy('FEE-01')
  @WriteRoles()
  @ApiCreatedResponse({ type: ProviderRateRowDto })
  addProviderRate(
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: AddProviderRateDto,
  ): Promise<ProviderRateRowDto> {
    return this.rates.add(admin.email, dto);
  }
}
