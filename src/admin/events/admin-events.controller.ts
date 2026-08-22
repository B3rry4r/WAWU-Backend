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
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminEventsService } from './admin-events.service';
import {
  AdminEventListQueryDto,
  AdminEventQueueQueryDto,
} from './dto/admin-event-queue-query.dto';
import { EventDecisionReasonDto } from './dto/event-decision-reason.dto';

/**
 * Event moderation — `/api/hub/admin/events/*` once the global prefix is
 * applied. Reinstated 22 Aug 2026 by product-owner decision, together with the
 * app-facing half in `src/event/`.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   read  (list, queue, detail)                     — superadmin, reviewer, support
 *   write (approve, reject, feature, unfeature,
 *          remove, restore)                         — superadmin, reviewer
 *   finance                                         — refused entirely, every route
 *
 * The same matrix as `admin/content`, deliberately: an admin who moderates
 * uploads moderates events, and a second role vocabulary for a second
 * moderation surface is how a permission model stops being reviewable.
 *
 * Support can READ because "why is my event not showing" is a support ticket
 * and answering it should not require a reviewer. Finance is refused rather
 * than given read-only access for the plainest possible reason: events take no
 * money in this product — no ticket, no price, no split — so there is nothing
 * on this surface that is a finance job, and a moderation control is not a
 * report. Every handler names its roles explicitly; AdminRolesGuard does not
 * treat superadmin as implicitly allowed, so the matrix is readable here rather
 * than implied in the guard.
 *
 * ── ROUTE ORDER ──────────────────────────────────────────────────────────────
 * The literal `queue` is declared before `:id` because Nest matches in
 * declaration order. ParseUUIDPipe on `:id` would 400 on "queue" anyway, but
 * relying on a 400 to protect a route is not the same as the route being
 * reachable on purpose.
 *
 * That pipe is version-UNPINNED, matching AdminContentReviewController for the
 * same reason: Prisma's `@default(uuid())` emits v4, but the fixture and seed
 * ids actually present in this database do not all, and pinning `{ version:
 * '4' }` would 400 on real stored rows — which a dashboard renders as "not
 * found".
 *
 * No path segment here collides with an existing controller: every route is
 * `admin/events/...`, nothing outside `src/admin/` declares an `admin` prefix,
 * and the app's own events routes are `@Controller('events')` — a different
 * first segment. Verified against the route table on a real boot, not by
 * reading imports.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/events')
export class AdminEventsController {
  constructor(private readonly service: AdminEventsService) {}

  /**
   * Every event at every status, `?status=` to narrow.
   *
   * Declared first because it is how an admin reaches a PUBLISHED event — the
   * only kind feature and takedown can act on, and by definition never in the
   * pending queue.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get()
  list(@Query() query: AdminEventListQueryDto) {
    return this.service.list(query);
  }

  /** Everything waiting on a human decision, oldest first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('queue')
  queue(@Query() query: AdminEventQueueQueryDto) {
    return this.service.queue(query);
  }

  /** One event in full, at any status, including its moderation history. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /**
   * pending → published. From here the event appears on GET /events for every
   * signed-in user.
   *
   * `@HttpCode(200)` on this and every write below: nothing is created, and the
   * ResponseInterceptor stamps `statusCode: 200` into the body regardless
   * (hazard H-3) — a 201 would ship a body that contradicts its own status
   * line.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.approve(id, admin);
  }

  /** pending → rejected. Reason required — the host is shown it. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EventDecisionReasonDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.reject(id, dto, admin);
  }

  /** Pin to the featured rail. Published events only. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/feature')
  @HttpCode(HttpStatus.OK)
  feature(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.feature(id, admin);
  }

  /** Unpin. Any status — see AdminEventsService.unfeature. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/unfeature')
  @HttpCode(HttpStatus.OK)
  unfeature(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.unfeature(id, admin);
  }

  /**
   * Take a published event down. Reason required, and the pin comes off in the
   * same write. Nothing is refunded because nothing was ever charged.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/remove')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EventDecisionReasonDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.remove(id, dto, admin);
  }

  /** removed → published. The exit that keeps a takedown from being a one-way door. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.restore(id, admin);
  }
}
