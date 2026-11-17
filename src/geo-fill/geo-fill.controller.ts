import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { GeoFillService, type GeoFillReport } from './geo-fill.service';

/**
 * GEO-FILL (R-143): `POST /api/hub/admin/geo/fill-countries`, superadmin only.
 * Runs the same fill the app runs by itself once a day, now. Safe to run twice
 * and safe if two people press it at once. Support, finance and reviewer are
 * refused. `admin/geo` also carries `GET counts` (AdminGeoController); the two
 * paths do not meet.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/geo')
export class GeoFillController {
  constructor(private readonly fill: GeoFillService) {}

  @AdminRoles(AdminRole.superadmin)
  @Post('fill-countries')
  @HttpCode(HttpStatus.OK)
  fillCountries(): Promise<GeoFillReport> {
    return this.fill.run();
  }
}
