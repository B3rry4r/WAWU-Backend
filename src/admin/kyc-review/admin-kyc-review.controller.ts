import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminKycReviewService } from './admin-kyc-review.service';
import { AdminKycQueueQueryDto } from './dto/admin-kyc-queue-query.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';

/**
 * KYC review — the EARNING gate. `/api/hub/admin/kyc/*` once the global prefix
 * is applied.
 *
 * This is not the verification-tier ladder and shares nothing with it: no
 * route, no screen, no vocabulary. That ladder is a public trust badge and
 * lives at `/api/hub/admin/verification/*` in its own module. CLAUDE.md lists
 * the two as independent gates and the conflation has already shipped once.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   read (queue, detail)                — superadmin, reviewer
 *   document fetch, unmask, decide      — superadmin, reviewer
 *   support                             — refused entirely
 *   finance                             — refused entirely
 *
 * Support is refused, and that is a deliberate departure from
 * ../content-review, where support CAN read the queue. A KycSubmission row is
 * a BVN, a NIN and a payout account number for one named Nigerian creator —
 * an identity-theft and bank-fraud kit, not a work item. The support ticket
 * this access would answer is "what is happening with my KYC?", and that is
 * already answerable from CreatorState.kycStatus, which carries no PII and is
 * on the person console. Nothing in a support job requires the numbers
 * themselves, so the default is no, including for the masked list: masking is
 * a display choice on this surface, and the same session that can list can
 * also reach the unmask endpoint's 403 — better that the whole resource be
 * out of reach than that the boundary be one decorator wide.
 *
 * Finance is refused for the same reason it is refused on content review, only
 * more so: payout account numbers are exactly the thing a finance role would
 * seem to have a claim on, and exactly the thing whose disclosure needs a
 * reviewer's audit trail behind it.
 *
 * Route order matters: the literal `queue` is declared before `:id` because
 * Nest matches in declaration order. `ParseUUIDPipe` on `:id` would reject
 * 'queue' anyway, but relying on a 400 to protect a route is not the same as
 * the route being reachable.
 *
 * That pipe is version-UNPINNED, matching the app's own KycSubmissionController
 * for the same entity id rather than the `{ version: '4' }` form used
 * elsewhere in this codebase — the admin route must accept exactly the ids the
 * existing route accepts, or a submission reachable by one would 400 on the
 * other (law 8).
 *
 * No path segment here collides with an existing controller: the app's own KYC
 * routes are `@Controller('kyc')`, a different first segment, and nothing else
 * in this backend declares an `admin` prefix.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/kyc')
export class AdminKycReviewController {
  constructor(private readonly service: AdminKycReviewService) {}

  /** Everything waiting on a human decision, oldest first, identifiers masked. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('queue')
  queue(@Query() query: AdminKycQueueQueryDto) {
    return this.service.queue(query);
  }

  /** One submission in full — creator gate state, submission history, audit trail. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /**
   * A short-lived signed URL for the government ID.
   *
   * POST rather than GET so that opening an ID is a recorded action rather
   * than a cacheable read — every call writes an audit row naming the admin.
   * The body is empty; the global ValidationPipe's `forbidNonWhitelisted`
   * means anything sent in it is a 400.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/document-url')
  @HttpCode(HttpStatus.OK)
  documentUrl(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AdminUserView) {
    return this.service.documentUrl(id, admin);
  }

  /**
   * The unmasked BVN / NIN / payout account, for the reviewer who has to key
   * them into a bank check. Audited on every call.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/reveal')
  @HttpCode(HttpStatus.OK)
  reveal(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AdminUserView) {
    return this.service.reveal(id, admin);
  }

  /**
   * pending → approved. Flips CreatorState.kycStatus through the existing
   * review service, which is what unlocks earning.
   *
   * `@HttpCode(200)`: nothing is created, and the ResponseInterceptor stamps
   * `statusCode: 200` into the body regardless (hazard H-3) — a 201 would ship
   * that mismatch into a new surface for no reason. The app's own
   * `POST /kyc/:id/review` is 200 for the same decision.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AdminUserView) {
    return this.service.approve(id, admin);
  }

  /** pending → rejected, reason required — the creator is shown it and can resubmit. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectKycDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.reject(id, dto, admin);
  }
}
