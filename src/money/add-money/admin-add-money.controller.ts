import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminAddMoneyActDto, AdminAddMoneyQueryDto } from './add-money.dto';
import { AddMoneyService } from './add-money.service';
import type {
  AdminAddMoneyPage,
  AdminAddMoneyView,
} from './add-money-view.type';

/**
 * Admin controls over add-money attempts (WALLET-25, WALLET-26; owner-asked):
 * `/api/hub/admin/money/add-money`. Superadmin and finance. Listing and
 * reading change nothing; freeze, unfreeze and cancel each write an audit row
 * with the change, in one transaction.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/add-money')
export class AdminAddMoneyController {
  constructor(private readonly addMoney: AddMoneyService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() q: AdminAddMoneyQueryDto): Promise<AdminAddMoneyPage> {
    return this.addMoney.adminList(q);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminAddMoneyView> {
    return this.addMoney.adminGet(id);
  }

  /** Stops an open attempt from being credited until it is unfrozen. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/freeze')
  @HttpCode(200)
  freeze(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: AdminAddMoneyActDto,
  ): Promise<AdminAddMoneyView> {
    return this.addMoney.adminFreeze(id, true, admin, dto.reason ?? null);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/unfreeze')
  @HttpCode(200)
  unfreeze(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: AdminAddMoneyActDto,
  ): Promise<AdminAddMoneyView> {
    return this.addMoney.adminFreeze(id, false, admin, dto.reason ?? null);
  }

  /** Cancels an attempt the provider has not taken. A taken or credited one is refused. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: AdminAddMoneyActDto,
  ): Promise<AdminAddMoneyView> {
    return this.addMoney.adminCancel(id, admin, dto.reason ?? null);
  }
}
