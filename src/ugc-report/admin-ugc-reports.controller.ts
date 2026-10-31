import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { AdminUgcReportsQueryDto } from './dto/admin-ugc-reports-query.dto';
import { ResolveUgcReportDto } from './dto/resolve-ugc-report.dto';
import { AdminUgcReportsService } from './admin-ugc-reports.service';

/**
 * REPORT-UGC moderation queue, `/api/hub/admin/reports`.
 *
 *   read    (list)     superadmin, reviewer, support
 *   write   (resolve)  superadmin, reviewer
 *   finance            refused on both routes
 *
 * Same roles as content review: the people who read the content queue read this one, and the people who may take a
 * piece down may take a reported item down.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/reports')
export class AdminUgcReportsController {
  constructor(private readonly service: AdminUgcReportsService) {}

  /** Open reports, one row per reported item, oldest first, with the item, the first reporter and the count. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get()
  list(@Query() query: AdminUgcReportsQueryDto) {
    return this.service.list(query);
  }

  /** Dismiss the report, or take the item down. Settles every open report on the same item. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveUgcReportDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.resolve(id, dto, admin);
  }
}
