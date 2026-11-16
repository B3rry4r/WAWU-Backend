import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import type { AdminUserCountsView } from './admin-users-view.type';

/**
 * USERS-DASH (R-142): everyone who signed up, `/api/hub/admin/users` and
 * `/api/hub/admin/users/counts`. Read only.
 *
 *   both routes: superadmin, support. Finance and reviewer are refused (403),
 *   as `/admin/creators` refuses a role it does not allow.
 *
 * `admin/users` also carries `:id/suspend|lift|suspension` (AdminUserSuspensionController);
 * those have a second segment, so neither route here meets them.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  /**
   * The list, newest first. The envelope is the usual `{ statusCode, message,
   * data: [...], pagination }` plus `contactUnavailable` beside it. Written here
   * (not returned) because the shared interceptor keeps only the four paging
   * fields and `src/common/**` is fenced.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get()
  async list(
    @Query() query: AdminUsersQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const page = await this.service.list(query);
    const { items, currentPage, perPage, total, contactUnavailable } = page;
    res.status(200).json({
      statusCode: 200,
      message: 'OK',
      data: items,
      pagination: {
        currentPage,
        nextPage: currentPage * perPage < total ? currentPage + 1 : null,
        perPage,
        total,
      },
      contactUnavailable,
    });
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get('counts')
  counts(): Promise<AdminUserCountsView> {
    return this.service.counts();
  }
}
