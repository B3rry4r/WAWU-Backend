import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminVerificationReviewService } from './admin-verification-review.service';
import { AdminVerificationQueueQueryDto } from './dto/admin-verification-queue-query.dto';
import { RejectVerificationDto } from './dto/reject-verification.dto';
import { VerificationDocumentUrlDto } from './dto/verification-document-url.dto';

/**
 * Verification-tier review — the PUBLIC TRUST BADGE.
 * `/api/hub/admin/verification/*` once the global prefix is applied.
 *
 * A separate top-level resource from `/api/hub/admin/kyc/*`, and separate on
 * purpose: no shared route, no shared filter, no combined "verification
 * status" anywhere. This surface's vocabulary is "tier", "badge" and
 * "applicant"; it never says "KYC", "payout" or "earning", and the KYC surface
 * never says "verified" or "tier". CLAUDE.md calls the two independent gates
 * and the app has already shipped copy that conflated them.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   read (queue, detail)      — superadmin, reviewer, support
 *   document fetch, decide    — superadmin, reviewer
 *   finance                   — refused entirely
 *
 * Support CAN read here, and cannot read KYC at all. The difference is what
 * the row holds: a VerificationSubmission is a tier, a status and a list of
 * document references, so "where has my badge application got to?" is
 * answerable without disclosing anything about the person. A KycSubmission is
 * a BVN, a NIN and a payout account number, which is why that surface refuses
 * support outright.
 *
 * Support still cannot fetch a document. Business registrations and
 * professional certificates carry personal data, opening one is a disclosure
 * that belongs in a reviewer's audit trail, and nothing in answering a support
 * ticket requires the file itself.
 *
 * Finance is refused entirely: this ladder has no money in it, so a finance
 * role has no claim on it.
 *
 * Route order matters: the literal `queue` is declared before `:id` because
 * Nest matches in declaration order. `ParseUUIDPipe` is version-UNPINNED,
 * matching the app's own VerificationSubmissionController for the same entity
 * id — the admin route must accept exactly the ids the existing route accepts.
 *
 * No collision with an existing controller: the app's own routes are
 * `@Controller('verification')`, a different first segment.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/verification')
export class AdminVerificationReviewController {
  constructor(private readonly service: AdminVerificationReviewService) {}

  /** Everything waiting on a human decision, oldest first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('queue')
  queue(@Query() query: AdminVerificationQueueQueryDto) {
    return this.service.queue(query);
  }

  /** One submission in full — documents, applicant history, audit trail. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /**
   * A short-lived signed URL for one submitted document.
   *
   * POST rather than GET so that opening evidence is a recorded action rather
   * than a cacheable read — every call writes an audit row naming the admin
   * and which document they opened.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/document-url')
  @HttpCode(HttpStatus.OK)
  documentUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerificationDocumentUrlDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.documentUrl(id, dto, admin);
  }

  /**
   * pending → approved, elevating the tier at WAWU ID first.
   *
   * `@HttpCode(200)` matches the app's own review route and avoids shipping
   * the interceptor's hardcoded `statusCode: 200` (hazard H-3) alongside a 201.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AdminUserView) {
    return this.service.approve(id, admin);
  }

  /** pending → rejected, reason required — the applicant is shown it and can resubmit. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectVerificationDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.reject(id, dto, admin);
  }
}
