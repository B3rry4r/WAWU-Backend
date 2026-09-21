import {
  Body,
  Controller,
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
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminCampaignQueryDto } from './dto/admin-campaign-query.dto';
import { ComposeCampaignDto } from './dto/compose-campaign.dto';
import { CAMPAIGN_DESTINATIONS } from './campaign-destination';

/**
 * Notification campaigns - `/api/hub/admin/notifications/*` once the global
 * prefix is applied. Build brief C8's admin half.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   read (audiences, list, detail, destinations) - superadmin, reviewer, support
 *   compose / edit a DRAFT                       - superadmin, reviewer
 *   DISPATCH                                     - superadmin ONLY
 *   finance                                      - refused entirely
 *
 * Dispatch is narrower than every other write in this backend, and
 * deliberately so. Approving one event or rejecting one upload affects one
 * person and can be reversed; a dispatch writes into every account on the
 * platform and cannot be taken back, because the notification has been read
 * by the time anyone regrets it. That is a capability, not a task, and it
 * belongs to the role that is already accountable for the platform.
 *
 * Reviewers compose and edit drafts because writing the copy IS the reviewing
 * job, and making a superadmin type every announcement is how announcements
 * stop being reviewed. Support reads so "why did I get this message" is
 * answerable from the dashboard without a reviewer.
 *
 * Finance is refused outright: there is no money on this surface, so no
 * finance task needs it.
 *
 * Route order matters - Nest matches in declaration order, so the literal
 * `campaigns`, `audiences` and `destinations` segments are declared before
 * anything with a `:id`. `ParseUUIDPipe` is version-UNPINNED, matching every
 * other admin controller here: Prisma's `@default(uuid())` emits v4 but the
 * ids already in the data do not all, and pinning v4 would 400 on real stored
 * rows (law 8 - the shapes in the data are facts, not choices).
 *
 * No path collides with an existing controller: the app's own notification
 * routes are `@Controller('notifications')`, a different first segment.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly service: AdminNotificationsService) {}

  /**
   * Every segment with its LIVE size and how many of them have announcements
   * switched on. The composer shows both beside each option, so the number an
   * admin sends against is measured rather than assumed.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('audiences')
  audiences() {
    return this.service.audiences();
  }

  /**
   * The allowlist of in-app destinations a campaign button may point at.
   * Served rather than hard-coded in the dashboard so the two cannot drift:
   * a destination this backend will refuse must never be offerable.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('destinations')
  destinations() {
    return CAMPAIGN_DESTINATIONS.map((d) => ({ ...d }));
  }

  /** The send history, newest first. Drafts included. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('campaigns')
  list(@Query() query: AdminCampaignQueryDto) {
    return this.service.list(query);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('campaigns/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /**
   * Compose a draft. Sends nothing: composing and dispatching are two calls,
   * so a campaign is always read back before it reaches anybody.
   *
   * `@HttpCode(200)`: the ResponseInterceptor stamps `statusCode: 200` into
   * the body regardless (hazard H-3), and a 201 would ship that mismatch into
   * a new surface for no reason. Same choice as every other admin write here.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('campaigns')
  @HttpCode(HttpStatus.OK)
  compose(@Body() dto: ComposeCampaignDto, @CurrentAdmin() admin: AdminUserView) {
    return this.service.compose(dto, admin);
  }

  /** Edit a draft. A sent campaign is refused: it is the record of what people saw. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch('campaigns/:id')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ComposeCampaignDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.update(id, dto, admin);
  }

  /**
   * Send it. Superadmin only, and there is no unsend.
   *
   * Returns the two counts and the difference between them, so the admin who
   * pressed the button sees the opt-out rate immediately rather than reading
   * "Sent" and assuming it reached everybody.
   */
  @AdminRoles(AdminRole.superadmin)
  @Post('campaigns/:id/dispatch')
  @HttpCode(HttpStatus.OK)
  dispatch(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AdminUserView) {
    return this.service.dispatch(id, admin);
  }
}
