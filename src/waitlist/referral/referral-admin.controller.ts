import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { ReferralAdminService } from './referral-admin.service';
import { CreateReferralCodeDto, UpdateReferralCodeDto } from './referral.dto';
import type { AdminReferralCodeView } from './referral-view.type';

/**
 * The team's referral codes (REF-01): `/api/hub/admin/waitlist/referral-codes`.
 *
 * ROLE MATRIX: reading the list is superadmin, finance and support (the same
 * people who read the registrations); creating and changing a code is
 * superadmin only, because a code sets what people pay. Codes are never
 * deleted: a code is switched off with `active: false`. A change to a price or
 * a limit affects only registrations started after it.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/waitlist/referral-codes')
export class ReferralAdminController {
  constructor(private readonly referrals: ReferralAdminService) {}

  /** Every code with its paid count, held count, money paid and limit. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get()
  @Header('Cache-Control', 'no-store')
  list(): Promise<AdminReferralCodeView[]> {
    return this.referrals.list();
  }

  /** Make a code. The price is from 0 (free) to the offer's standard price. */
  @AdminRoles(AdminRole.superadmin)
  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  create(
    @Body() dto: CreateReferralCodeDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<AdminReferralCodeView> {
    return this.referrals.create(dto, admin.id);
  }

  /** Change a code's community, price, limit (null for none) or on/off. */
  @AdminRoles(AdminRole.superadmin)
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateReferralCodeDto,
  ): Promise<AdminReferralCodeView> {
    return this.referrals.update(id, dto);
  }
}
