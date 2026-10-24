import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { BuiltBy } from '../money-contract';
import {
  AdminFxFreezeDto,
  AdminFxOperationsQueryDto,
} from './dto/fx-request.dto';
import { FxAdminService } from './fx-admin.service';
import type {
  AdminFxAccountListView,
  AdminFxFreezeView,
  AdminFxOperationPage,
  AdminFxOperationView,
} from './fx-view.type';

/**
 * What the admin dashboard sees of foreign accounts, swaps and crypto sends
 * (task WALLET-21, R-84): a person's accounts, every swap and send, and one
 * account frozen or let go. Superadmin and finance only; reviewer and
 * support are refused on every route (AdminRolesGuard does not treat
 * superadmin as implicitly allowed, so each handler names its roles). The two
 * writes (freeze, unfreeze) only change WAWU's own record of the account and
 * leave an audit row each (who, what, why, when); nothing here moves money.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/fx')
export class FxAdminController {
  constructor(private readonly admin: FxAdminService) {}

  /** A person's foreign accounts with the provider's balances and details. */
  @Get('people/:wawuUserId/accounts')
  @BuiltBy('WALLET-21')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  personAccounts(
    @Param('wawuUserId') wawuUserId: string,
  ): Promise<AdminFxAccountListView> {
    return this.admin.personAccounts(wawuUserId);
  }

  /** Swaps and sends, newest first, for one person or for everyone. */
  @Get('operations')
  @BuiltBy('WALLET-21')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  operations(
    @Query() query: AdminFxOperationsQueryDto,
  ): Promise<AdminFxOperationPage> {
    return this.admin.operations(query);
  }

  /** One swap or send. */
  @Get('operations/:id')
  @BuiltBy('WALLET-21')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  operation(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminFxOperationView> {
    return this.admin.operation(id);
  }

  /**
   * Freezes one account: from then on nothing leaves it (a swap from it, a
   * crypto send) and nothing is swapped into it; money can still arrive.
   * Needs a reason. Freezing a frozen account changes nothing and writes no
   * second audit row.
   */
  @Post('accounts/:id/freeze')
  @HttpCode(200)
  @BuiltBy('WALLET-21')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  freeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminFxFreezeDto,
  ): Promise<AdminFxFreezeView> {
    return this.admin.setFrozen(admin, id, 'freeze', dto.reason.trim());
  }

  /** Lets go of a frozen account. Needs a reason; one audit row. */
  @Post('accounts/:id/unfreeze')
  @HttpCode(200)
  @BuiltBy('WALLET-21')
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  unfreeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminFxFreezeDto,
  ): Promise<AdminFxFreezeView> {
    return this.admin.setFrozen(admin, id, 'unfreeze', dto.reason.trim());
  }
}
