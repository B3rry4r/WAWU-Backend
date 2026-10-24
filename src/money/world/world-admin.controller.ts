import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { BuiltBy } from '../money-contract';
import {
  AdminWorldActDto,
  AdminWorldOpeningsQueryDto,
} from './dto/world-request.dto';
import { WorldAdminService } from './world-admin.service';
import type {
  AdminWorldActView,
  AdminWorldOpeningPage,
} from './world-view.type';

/**
 * What the admin dashboard sees of wallets opened outside Nigeria, and what
 * support can do (task WALLET-41, R-87): list them, freeze or let go of one,
 * cancel an opening that is not open yet. Superadmin and finance only;
 * reviewer and support are refused on every route (each handler names its
 * roles). Every act needs a reason and leaves one audit row.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/world')
export class WorldAdminController {
  constructor(private readonly admin: WorldAdminService) {}

  /** World openings and wallets, newest first; filters `country` and `stage`; a cursor page. */
  @Get('openings')
  @BuiltBy('WALLET-41')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  openings(
    @Query() query: AdminWorldOpeningsQueryDto,
  ): Promise<AdminWorldOpeningPage> {
    return this.admin.list(query);
  }

  /**
   * Freezes a person's world wallet: their foreign accounts stop paying out
   * (money can still arrive) and no new account is opened for them. Freezing
   * a frozen wallet changes nothing and writes no second audit row.
   */
  @Post('openings/:wawuUserId/freeze')
  @HttpCode(200)
  @BuiltBy('WALLET-41')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  freeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminWorldActDto,
  ): Promise<AdminWorldActView> {
    return this.admin.act(admin, wawuUserId, 'freeze', dto.reason.trim());
  }

  /** Lets go of a frozen world wallet (only the accounts this freeze froze). */
  @Post('openings/:wawuUserId/unfreeze')
  @HttpCode(200)
  @BuiltBy('WALLET-41')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  unfreeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminWorldActDto,
  ): Promise<AdminWorldActView> {
    return this.admin.act(admin, wawuUserId, 'unfreeze', dto.reason.trim());
  }

  /**
   * Cancels an opening that is not open yet: the review is stopped on WAWU's
   * side and the identity claim is let go (nothing is deleted at the provider).
   * Refused for a wallet that is already open (freeze it instead).
   */
  @Post('openings/:wawuUserId/cancel')
  @HttpCode(200)
  @BuiltBy('WALLET-41')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  cancel(
    @CurrentAdmin() admin: AdminUserView,
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminWorldActDto,
  ): Promise<AdminWorldActView> {
    return this.admin.act(admin, wawuUserId, 'cancel', dto.reason.trim());
  }
}
