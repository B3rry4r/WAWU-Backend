import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { LiftSuspensionDto, SuspendUserDto } from './dto/suspend-user.dto';
import {
  UserSuspensionService,
  type AdminSuspensionView,
} from './user-suspension.service';

/**
 * USER-SUSPEND (R-121), `/api/hub/admin/users/:id/...`. `:id` is the person's WAWU id.
 *
 *   suspend, lift, read   superadmin, reviewer, support
 *   finance               refused on all three
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every handler names the three roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/users')
export class AdminUserSuspensionController {
  constructor(private readonly service: UserSuspensionService) {}

  /** Suspend a person. Safe to repeat: a person already suspended answers their state and writes nothing. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendUserDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<AdminSuspensionView> {
    return this.service.suspend(id, dto, admin);
  }

  /** Lift the suspension in force. Everything of theirs is back at once; nothing was deleted. Safe to repeat. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Post(':id/lift')
  @HttpCode(HttpStatus.OK)
  lift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LiftSuspensionDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<AdminSuspensionView> {
    return this.service.lift(id, dto, admin);
  }

  /** Whether the person is suspended, and every suspension they have had. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get(':id/suspension')
  read(@Param('id', ParseUUIDPipe) id: string): Promise<AdminSuspensionView> {
    return this.service.view(id);
  }
}
