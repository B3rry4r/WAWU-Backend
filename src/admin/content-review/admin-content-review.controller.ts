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
import { AdminContentReviewService } from './admin-content-review.service';
import { AdminContentQueueQueryDto } from './dto/admin-content-queue-query.dto';
import { RejectContentDto } from './dto/reject-content.dto';
import { TakeDownContentDto } from './dto/take-down-content.dto';

/**
 * Content moderation — `/api/hub/admin/content/*` once the global prefix is
 * applied.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   read  (queue, detail)              — superadmin, reviewer, support
 *   write (approve, reject, take-down) — superadmin, reviewer
 *   finance                            — refused entirely, on every route here
 *
 * Support can read because "where is my upload?" is a support ticket and
 * answering it should not require a reviewer. Finance is refused rather than
 * given read-only access because these responses carry signed URLs to
 * unpublished creator assets, including the paid full asset behind the
 * paywall — that is a capability, not a view, and nothing in a finance job
 * needs it. Every handler names its roles explicitly; AdminRolesGuard does
 * not treat superadmin as implicitly allowed, so the matrix is readable here
 * rather than implied in the guard.
 *
 * Route order matters: the literal `queue` is declared before `:id` because
 * Nest matches in declaration order. `ParseUUIDPipe` on `:id` would reject
 * 'queue' anyway, but relying on a 400 to protect a route is not the same as
 * the route being reachable.
 *
 * That pipe is version-UNPINNED, matching the app's own
 * ContentPieceController for the same entity id and deliberately not the
 * `{ version: '4' }` form used elsewhere in this codebase. Prisma's
 * `@default(uuid())` does emit v4, but the ids actually present in the data
 * do not all: every seeded ContentPiece is `10000000-0000-4000-8000-...`,
 * whose version nibble is 0. Pinning v4 would 400 on real stored rows and the
 * dashboard would show that as "not found" (law 8 — the shapes in the data are
 * facts, not choices).
 *
 * No path segment here collides with an existing controller: nothing else in
 * this backend declares an `admin` prefix, and the app's own content routes
 * are `@Controller('content')`, a different first segment.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/content')
export class AdminContentReviewController {
  constructor(private readonly service: AdminContentReviewService) {}

  /** Everything waiting on a human decision, oldest first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('queue')
  queue(@Query() query: AdminContentQueueQueryDto) {
    return this.service.queue(query);
  }

  /** One piece in full, at any status, including its moderation history. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /**
   * pending → live. The first write of 'live' this backend has ever had: from
   * here the piece is visible on every existing public read path.
   *
   * `@HttpCode(200)`: nothing is created, and the ResponseInterceptor stamps
   * `statusCode: 200` into the body regardless (hazard H-3) — a 201 would ship
   * that mismatch into a new surface for no reason.
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

  /** pending → rejected, reason required, and the creator's upload slot comes back. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectContentDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.reject(id, dto, admin);
  }

  /**
   * Any non-removed status → removed, reason required. The takedown lever
   * for content stranded live with no pending review to reject it from and,
   * often, no creator account left behind it — see AdminContentReviewService
   * .takeDown for why that gap exists.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/take-down')
  @HttpCode(HttpStatus.OK)
  takeDown(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TakeDownContentDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.takeDown(id, dto, admin);
  }
}
