import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminGeoService } from './admin-geo.service';
import { AdminGeoCountsQueryDto } from './dto/admin-geo-counts-query.dto';
import type { AdminGeoCountsView } from '../../geo/geo.types';

/**
 * Where the accounts are (GEO-02, R-85) — `/api/hub/admin/geo/*`.
 *
 * ── ROLE MATRIX ───────────────────────────────────────────────────────────
 *   counts — superadmin, support, finance (the same three that read
 *   `/admin/creators`); reviewer is refused, as there.
 *
 * Counts only: no name, handle, phone or id appears. The people behind a
 * line are found with `GET /admin/creators?countryCode=&regionCode=`.
 *
 * `admin/geo` is a prefix no other controller declares (`AdminSchoolsController`
 * is `@Controller('admin')` but declares only its own named routes).
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/geo')
export class AdminGeoController {
  constructor(private readonly service: AdminGeoService) {}

  /** Accounts by country and, inside each, by region, with how many are creators. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support, AdminRole.finance)
  @Get('counts')
  counts(@Query() query: AdminGeoCountsQueryDto): Promise<AdminGeoCountsView> {
    return this.service.counts(query);
  }
}
