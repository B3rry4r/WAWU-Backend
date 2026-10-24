import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import {
  AdminCapitalService,
  type AdminCapitalOrderView,
  type AdminCapitalPage,
} from './admin-capital.service';
import { CapitalAdminActDto, CapitalAdminListQueryDto } from './capital.dto';

/**
 * Capital orders for the dashboard (task NUV-12) -- `/api/hub/admin/capital/*`.
 *
 * ── ROLE MATRIX ───────────────────────────────────────────────────────────
 *   list, freeze, unfreeze, cancel   -- superadmin, finance
 *   reviewer, support                -- refused entirely
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every
 * handler names both roles. Each act writes an audit row (who, what, when).
 * A person's name, phone and numbers never appear: orders are named by their
 * WAWU id and the product.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/capital/orders')
export class AdminCapitalController {
  constructor(private readonly admin: AdminCapitalService) {}

  /** Orders newest first; `state` and `wawuUserId` narrow them. A reservation that never reached the provider is not listed. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: CapitalAdminListQueryDto): Promise<AdminCapitalPage> {
    return this.admin.list(query);
  }

  /** Stops confirmations and withdrawals on one order until it is lifted. Nothing is undone at the provider. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/freeze')
  @HttpCode(HttpStatus.OK)
  freeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapitalAdminActDto,
  ): Promise<AdminCapitalOrderView> {
    return this.admin.act(admin, id, 'freeze', dto.note);
  }

  /** Lifts a hold. 409 when the order is not on hold. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/unfreeze')
  @HttpCode(HttpStatus.OK)
  unfreeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapitalAdminActDto,
  ): Promise<AdminCapitalOrderView> {
    return this.admin.act(admin, id, 'unfreeze', dto.note);
  }

  /** Cancels a reservation that has not been confirmed. 409 for any other state: an invested order is held, not cancelled. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapitalAdminActDto,
  ): Promise<AdminCapitalOrderView> {
    return this.admin.act(admin, id, 'cancel', dto.note);
  }
}
