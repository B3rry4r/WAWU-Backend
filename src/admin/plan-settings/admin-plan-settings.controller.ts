import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import {
  PlanSettingsService,
  type PlanSettingsView,
} from '../../plan-settings/plan-settings.service';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { UpdatePlanSettingsDto } from './update-plan-settings.dto';

/**
 * The launch figures WAWU sets in admin (TIER-06, R-65) -
 * `/api/hub/admin/plan-settings` once the global prefix is applied: tier
 * prices and lengths, the add-5-products price, the points rate, expiry and
 * daily cap, the points packs, the AI tool costs, the referral ladder and the
 * event pass lines and date. The app reads every one of them from the Hub;
 * nothing in code holds a figure. 85/15 is not here: it is the one split.
 *
 * ── ROLE MATRIX (enforced per handler) ────────────────────────────────────
 *   read      superadmin, finance, support
 *   change    superadmin, finance
 *   reviewer  refused
 *
 * Changing a price is a money decision, the same call as setting a legal
 * price (`/legal/ops/prices`), so it sits with the same roles. A user token is
 * 401 on both routes: AdminAuthGuard accepts nothing else. AdminRolesGuard
 * does not treat superadmin as implicitly allowed, so every handler names its
 * roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/plan-settings')
export class AdminPlanSettingsController {
  constructor(private readonly settings: PlanSettingsService) {}

  /** Every setting with its value, its default and the screens that print it. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get()
  list(): PlanSettingsView {
    return this.settings.describe();
  }

  /**
   * Changes one or more settings. A null value puts a setting back to its
   * default. All or nothing: one bad value refuses the request. Writes one
   * audit row per setting that changed, and the next quote uses the new figure
   * with no restart. `@HttpCode(200)`: nothing is created, and the
   * ResponseInterceptor stamps `statusCode: 200` into the body regardless.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Patch()
  @HttpCode(HttpStatus.OK)
  update(
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: UpdatePlanSettingsDto,
  ): Promise<PlanSettingsView> {
    return this.settings.set(admin, dto);
  }
}
