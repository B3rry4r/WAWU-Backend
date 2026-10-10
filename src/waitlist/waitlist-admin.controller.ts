import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import type { Paginated } from '../common/interceptors/response.interceptor';
import {
  AdminWaitlistExportQueryDto,
  AdminWaitlistListQueryDto,
} from './dto/waitlist.dto';
import { CSV_BOM } from '../money/statements/statement-csv';
import {
  WAITLIST_EXPORT_CONTENT_TYPE,
  waitlistHeaderLine,
  waitlistLine,
} from './waitlist-export';
import { WaitlistService } from './waitlist.service';
import type {
  AdminWaitlistExportView,
  AdminWaitlistRegistrationView,
} from './waitlist-view.type';

/**
 * The team's view of the event registrations (JOIN-01): who registered and
 * who paid. Admin tokens only (a user token or no token is 401, because
 * AdminAuthGuard accepts nothing else).
 *
 * ROLE MATRIX: read and export by superadmin, finance and support (the
 * people who answer "did my payment go through" and reconcile the money);
 * reviewer is refused. The rows hold phones and emails, so nothing here is
 * wider than that. Read-only: no route here changes a registration.
 *
 * `admin/waitlist` is a first and second segment no other controller declares.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/waitlist/registrations')
export class WaitlistAdminController {
  constructor(private readonly waitlist: WaitlistService) {}

  /**
   * Registrations, newest first, every status unless `status` is given
   * (`pending`, `paid` or `failed`; a `failed` row is a second payment kept
   * for a refund). `offerId` narrows to one offer.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query() query: AdminWaitlistListQueryDto,
  ): Promise<Paginated<AdminWaitlistRegistrationView>> {
    return this.waitlist.adminList(query);
  }

  /**
   * The same rows as a CSV file, oldest first, inside the usual envelope
   * (`content` is the file; save it as `fileName`). A byte-order mark first,
   * so a spreadsheet opens it as UTF-8 and shows the naira sign.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get('export')
  @Header('Cache-Control', 'no-store')
  async export(
    @Query() query: AdminWaitlistExportQueryDto,
  ): Promise<AdminWaitlistExportView> {
    const generatedAt = new Date();
    let content = CSV_BOM + waitlistHeaderLine();
    let rowCount = 0;
    for await (const row of this.waitlist.adminRows(query)) {
      content += waitlistLine(row);
      rowCount += 1;
    }
    const day = generatedAt.toISOString().slice(0, 10);
    return {
      fileName: `registrations-${query.offerId ?? 'all'}${query.status ? `-${query.status}` : ''}-${day}.csv`,
      contentType: WAITLIST_EXPORT_CONTENT_TYPE,
      rowCount,
      content,
      generatedAt: generatedAt.toISOString(),
    };
  }
}
