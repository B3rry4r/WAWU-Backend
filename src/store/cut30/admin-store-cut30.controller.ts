import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole, StorePlatform } from '../../../generated/prisma/enums';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import {
  type StoreCut30StatusView,
  type StoreCut30SwitchBackView,
  StoreCut30Service,
} from './store-cut30.service';

/**
 * The stores' cut from 15% to 30% (STORE-CUT30, R-101 point 9): where each
 * store stands, and the admin action that moves its prices back to 15% (at the
 * new year; never automatic).
 *
 * ROLE MATRIX: superadmin and finance (the figures are WAWU's proceeds).
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/store/cut30')
export class AdminStoreCut30Controller {
  constructor(private readonly cut: StoreCut30Service) {}

  /** Both stores: this year's proceeds in US cents, the threshold, and the ladder in force (15 or 30). */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get()
  status(): Promise<StoreCut30StatusView[]> {
    return this.cut.status();
  }

  /** Puts one store's `wawu.buy.*` prices back on the 15% ladder. 409 when it is already on it. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':platform/switch-back')
  @HttpCode(HttpStatus.OK)
  switchBack(
    @CurrentAdmin() admin: AdminUserView,
    @Param('platform', new ParseEnumPipe(StorePlatform))
    platform: StorePlatform,
  ): Promise<StoreCut30SwitchBackView> {
    return this.cut.switchBack(platform, admin.id);
  }
}
