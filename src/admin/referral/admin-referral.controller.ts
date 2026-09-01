import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminReferralService } from './admin-referral.service';
import { ReferralService } from '../../referral/referral.service';
import {
  CreateReferralCodeDto,
  UserSignupDto,
  UpdateReferralCodeDto,
} from '../../referral/dto/referral.dto';

/**
 * `/api/hub/admin/referral/*` — issuing codes, and the switch that decides
 * whether anybody can sign up without one.
 *
 * Superadmin only. A code is a price and an invitation, so issuing one is
 * giving away revenue and access at the same time; that is not a support
 * action.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.superadmin)
@Controller('admin/referral')
export class AdminReferralController {
  constructor(
    private readonly admin: AdminReferralService,
    private readonly referral: ReferralService,
  ) {}

  @Get('codes')
  list() {
    return this.admin.list();
  }

  @Post('codes')
  create(@CurrentAdmin() admin: AdminUserView, @Body() dto: CreateReferralCodeDto) {
    return this.admin.create(dto, admin.id);
  }

  @Patch('codes/:code')
  update(@Param('code') code: string, @Body() dto: UpdateReferralCodeDto) {
    return this.admin.update(code, dto);
  }

  @Post('codes/:code/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(@Param('code') code: string) {
    return this.admin.deactivate(code);
  }

  @Get('signup-state')
  async signupState() {
    return { userSignupEnabled: await this.referral.userSignupEnabled() };
  }

  /** The toggle. Flipped from here, never from a deploy. */
  @Patch('signup-state')
  setSignupState(@Body() dto: UserSignupDto) {
    return this.referral.setUserSignupEnabled(dto.userSignupEnabled);
  }
}
