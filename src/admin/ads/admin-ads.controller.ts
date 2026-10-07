import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminAdsService } from './admin-ads.service';
import {
  AdCampaignFilterDto,
  AdCampaignListQueryDto,
  AdReportRangeDto,
  CreateAdCampaignDto,
  UpdateAdCampaignDto,
} from './dto/admin-ad.dto';

/**
 * Sponsored cards, admin side (task ADS-06, R-15): ads are booked by the WAWU
 * team and invoiced by hand, so this is where staff create, schedule, pause and
 * report on campaigns. `/api/hub/admin/ads/*` once the global prefix applies.
 * Admin tokens only (AdminAuthGuard): a user token is 401 here, and an admin
 * token is 401 on every user route.
 *
 * ── ROLE MATRIX (enforced per handler) ────────────────────────────────────
 *   read  (list, report, detail)        superadmin, reviewer, support, finance
 *   write (create, edit, schedule,
 *          pause, resume, end, delete)  superadmin, reviewer
 *
 * Finance reads because ads are invoiced by hand and the invoice starts from
 * this report. Writing is the moderation matrix (admin/events): a reviewer can
 * pause a card at once if it should not be on air. Every handler names its
 * roles; AdminRolesGuard does not treat superadmin as implicitly allowed.
 *
 * ── ROUTE ORDER ───────────────────────────────────────────────────────────
 * The literal `report` is declared before `:id`, so it is reached on purpose
 * and not because ParseUUIDPipe happens to refuse it. `ads` as a second
 * segment collides with nothing: the app's own `ads` route (ADS-04) has a
 * different first segment.
 *
 * Writes answer 200, never 201: the ResponseInterceptor stamps 200 into the
 * body, so a 201 would contradict itself (hazard H-3).
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/ads')
export class AdminAdsController {
  constructor(private readonly service: AdminAdsService) {}

  /** Campaigns, filtered by status, placement, phase and window, in a fixed order. */
  @AdminRoles(
    AdminRole.superadmin,
    AdminRole.reviewer,
    AdminRole.support,
    AdminRole.finance,
  )
  @Get()
  list(@Query() query: AdCampaignListQueryDto) {
    return this.service.list(query);
  }

  /** The bookings in a range, counted by status, placement and phase. */
  @AdminRoles(
    AdminRole.superadmin,
    AdminRole.reviewer,
    AdminRole.support,
    AdminRole.finance,
  )
  @Get('report')
  summary(@Query() query: AdCampaignFilterDto) {
    return this.service.summary(query);
  }

  /** Create a draft campaign with its card. Nothing is served until it is scheduled. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post()
  @HttpCode(HttpStatus.OK)
  create(
    @Body() dto: CreateAdCampaignDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.create(dto, admin);
  }

  /** One campaign in full: card, event, overlaps and history. */
  @AdminRoles(
    AdminRole.superadmin,
    AdminRole.reviewer,
    AdminRole.support,
    AdminRole.finance,
  )
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /** One campaign's report: its window, how much of it has run, what was done to it, and its views, taps and skips by day. */
  @AdminRoles(
    AdminRole.superadmin,
    AdminRole.reviewer,
    AdminRole.support,
    AdminRole.finance,
  )
  @Get(':id/report')
  report(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdReportRangeDto,
  ) {
    return this.service.report(id, query);
  }

  /** Edit a draft or a paused campaign. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdCampaignDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.update(id, dto, admin);
  }

  /** Delete a draft. Anything else is ended, not deleted. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.remove(id, admin);
  }

  /** draft to scheduled (or live, if its window has started). The booking is approved by being scheduled. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.schedule(id, admin);
  }

  /** scheduled or live to paused. The card stops being served on the next request. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.pause(id, admin);
  }

  /** paused back on air, while its window and its event are still open. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.resume(id, admin);
  }

  /** End early, from any status but ended. Final. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.end(id, admin);
  }
}
