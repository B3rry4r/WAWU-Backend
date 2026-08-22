import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { VerificationSubmissionService } from '../../verification-submission/verification-submission.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { AdminVerificationAuditModel, VerificationSubmissionModel } from '../../../generated/prisma/models';
import type { AdminUserView } from '../auth/admin-user-view.type';
import {
  toAdminVerificationAuditEntryView,
  type AdminVerificationApplicantView,
  type AdminVerificationDecisionView,
  type AdminVerificationDetailView,
  type AdminVerificationDocumentUrlView,
  type AdminVerificationQueueItemView,
} from './admin-verification-view.type';
import type { AdminVerificationQueueQueryDto } from './dto/admin-verification-queue-query.dto';
import type { RejectVerificationDto } from './dto/reject-verification.dto';
import type { VerificationDocumentUrlDto } from './dto/verification-document-url.dto';

/** Submitted evidence gets the shortest URL StorageService offers, never readUrlFor's seven days. */
const SIGNED_URL_TTL_SECONDS = 900;

const MS_PER_HOUR = 3_600_000;

/**
 * The reviewer's side of the verification-tier ladder — the PUBLIC TRUST
 * BADGE.
 *
 * This is not the earning gate. Approving here elevates a badge at WAWU ID;
 * it does not clear anybody to be paid, and it must never touch
 * CreatorState.kycStatus. The earning gate is ../kyc-review/, a separate
 * module with a separate audit table, because CLAUDE.md lists the two as
 * independent and the app has already shipped copy conflating them once.
 *
 * The same defect as KYC put this queue out of reach:
 * `POST /verification/submissions/:id/review` exists and is guarded, but
 * `listMine()` is `where: { wawuUserId }` and there is no other read, so
 * nothing could enumerate a pending submission and no reviewer could discover
 * an id. A ladder nobody can climb is a badge nobody can earn.
 *
 * ── WHAT THIS SERVICE DOES NOT DO ────────────────────────────────────────
 * It does not implement the review transition. `approve` and `reject`
 * delegate to the EXISTING, unmodified `VerificationSubmissionService.review()`
 * — listed in this module's providers, since VerificationSubmissionModule
 * exports nothing.
 *
 * Delegating matters more here than it does for KYC. That method elevates the
 * tier at WAWU ID BEFORE writing the local approval, and its own comment
 * explains why the other order is unrecoverable: review() refuses anything not
 * `pending`, so a local write followed by a failed callback would leave the
 * submission permanently approved here, never elevated there, and impossible
 * to retry through the API. A reimplementation would have to reproduce that
 * ordering exactly and would eventually not. There is also a hard rule behind
 * it — WAWU ID owns `verificationTier`; this backend elevates through
 * WawuIdClient and never writes a tier locally.
 */
@Injectable()
export class AdminVerificationReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly verification: VerificationSubmissionService,
  ) {}

  /** GET /admin/verification/queue — everything waiting on a human, oldest first. */
  async queue(
    query: AdminVerificationQueueQueryDto,
  ): Promise<Paginated<AdminVerificationQueueItemView>> {
    const where = { status: 'pending' as const, ...(query.tier ? { tier: query.tier } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.verificationSubmission.findMany({
        where,
        orderBy: { submittedAt: query.sort === 'newest' ? 'desc' : 'asc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.verificationSubmission.count({ where }),
    ]);

    const applicants = await this.resolveApplicants(rows.map((r) => r.wawuUserId));

    return {
      items: rows.map((row) => this.toQueueItem(row, applicants.get(row.wawuUserId))),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /** GET /admin/verification/:id — any status, so a reviewer can revisit a decision. */
  async detail(id: string): Promise<AdminVerificationDetailView> {
    return this.toDetail(await this.require(id));
  }

  /**
   * POST /admin/verification/:id/document-url — a short-lived signed GET for
   * one submitted document.
   *
   * POST, not GET, so opening evidence is a recorded action rather than a
   * cacheable read. The URL is returned and forgotten: never persisted, never
   * logged, never written into the audit row.
   */
  async documentUrl(
    id: string,
    dto: VerificationDocumentUrlDto,
    admin: AdminUserView,
  ): Promise<AdminVerificationDocumentUrlView> {
    const submission = await this.require(id);
    const stored = submission.documents[dto.documentIndex];
    if (stored === undefined) {
      throw new BadRequestException(
        `This submission has ${submission.documents.length} document(s); there is no document ${dto.documentIndex}.`,
      );
    }

    // StorageService returns an absolute URL verbatim instead of signing it,
    // and `documents` is free text the client filled in, so both shapes occur.
    // Saying "expires in 900s" over an absolute one would be false.
    const isAbsolute = stored.startsWith('http://') || stored.startsWith('https://');
    const url = await this.storage.signedReadUrl(stored, SIGNED_URL_TTL_SECONDS);

    const audit = await this.prisma.adminVerificationAudit.create({
      data: {
        submissionId: submission.id,
        subjectWawuUserId: submission.wawuUserId,
        tier: submission.tier,
        action: 'document_viewed',
        documentIndex: dto.documentIndex,
        ...this.actor(admin),
      },
    });

    return {
      index: dto.documentIndex,
      url,
      signed: !isAbsolute,
      expiresInSeconds: isAbsolute ? null : SIGNED_URL_TTL_SECONDS,
      expiresAt: isAbsolute ? null : new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000),
      audit: toAdminVerificationAuditEntryView(audit),
    };
  }

  /**
   * POST /admin/verification/:id/approve — elevates the badge at WAWU ID.
   *
   * The elevation happens inside the existing service, before the local write.
   * If WAWU ID refuses, that service throws and nothing is written here
   * either — no audit row, submission still pending, decision still
   * retryable. So an `approved` audit row can only exist once the elevation
   * succeeded, which is what `tierElevatedAtWawuId` records.
   */
  async approve(id: string, admin: AdminUserView): Promise<AdminVerificationDecisionView> {
    return this.decide(id, admin, 'approved', null);
  }

  /** POST /admin/verification/:id/reject — reason required; the applicant can then resubmit. */
  async reject(
    id: string,
    dto: RejectVerificationDto,
    admin: AdminUserView,
  ): Promise<AdminVerificationDecisionView> {
    return this.decide(id, admin, 'rejected', dto.reason.trim());
  }

  private async decide(
    id: string,
    admin: AdminUserView,
    decision: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<AdminVerificationDecisionView> {
    // Read first: the existing service returns only the updated row, and an
    // audit trail that cannot say what changed is a log, not a trail.
    const before = await this.require(id);

    const updated = await this.verification.review(id, {
      decision,
      rejectionReason: reason ?? undefined,
    });

    const audit = await this.prisma.adminVerificationAudit.create({
      data: {
        submissionId: id,
        subjectWawuUserId: before.wawuUserId,
        tier: before.tier,
        action: decision,
        previousStatus: before.status,
        newStatus: decision,
        reason,
        tierElevatedAtWawuId: decision === 'approved',
        ...this.actor(admin),
      },
    });

    return {
      submission: await this.toDetail(updated as VerificationSubmissionModel),
      audit: toAdminVerificationAuditEntryView(audit),
    };
  }

  // ── views ────────────────────────────────────────────────────────────────

  private async require(id: string): Promise<VerificationSubmissionModel> {
    const submission = await this.prisma.verificationSubmission.findUnique({ where: { id } });
    if (!submission) {
      // Same wording as VerificationSubmissionService's own 404, so the admin
      // route and the route it delegates to answer identically.
      throw new NotFoundException('Verification submission not found');
    }
    return submission;
  }

  private async toDetail(
    submission: VerificationSubmissionModel,
  ): Promise<AdminVerificationDetailView> {
    const [applicants, history, auditTrail] = await Promise.all([
      this.resolveApplicants([submission.wawuUserId]),
      this.prisma.verificationSubmission.findMany({
        where: { wawuUserId: submission.wawuUserId },
        orderBy: { submittedAt: 'desc' },
      }),
      this.prisma.adminVerificationAudit.findMany({
        where: { submissionId: submission.id },
        orderBy: { actedAt: 'desc' },
      }),
    ]);

    return {
      ...this.toQueueItem(submission, applicants.get(submission.wawuUserId)),
      documents: submission.documents.map((stored, index) => ({
        index,
        filename: documentFilenameFrom(stored),
      })),
      history: history.map((row) => ({
        id: row.id,
        tier: row.tier,
        status: row.status,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
        rejectionReason: row.rejectionReason,
      })),
      auditTrail: auditTrail.map((row: AdminVerificationAuditModel) =>
        toAdminVerificationAuditEntryView(row),
      ),
    };
  }

  private toQueueItem(
    submission: VerificationSubmissionModel,
    applicant: AdminVerificationApplicantView | undefined,
  ): AdminVerificationQueueItemView {
    return {
      id: submission.id,
      tier: submission.tier,
      status: submission.status,
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt,
      rejectionReason: submission.rejectionReason,
      waitingHours: Math.max(
        0,
        Math.floor((Date.now() - submission.submittedAt.getTime()) / MS_PER_HOUR),
      ),
      documentCount: submission.documents.length,
      applicant: applicant ?? emptyApplicantView(submission.wawuUserId),
    };
  }

  /**
   * Applicant context in one batched read.
   *
   * Deliberately thin: a handle and an account type. This surface has no
   * business showing a creator's gates, earnings or KYC state — the ladder is
   * open to every WAWU user, creator or not, and pulling the earning gate onto
   * this screen is precisely the conflation the product forbids.
   */
  private async resolveApplicants(
    wawuUserIds: string[],
  ): Promise<Map<string, AdminVerificationApplicantView>> {
    const ids = [...new Set(wawuUserIds)];
    if (ids.length === 0) return new Map();

    const profiles = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: ids } },
      select: { wawuUserId: true, handle: true, accountType: true },
    });
    const byId = new Map(profiles.map((p) => [p.wawuUserId, p]));

    return new Map(
      ids.map((wawuUserId) => {
        const profile = byId.get(wawuUserId);
        return [
          wawuUserId,
          {
            wawuUserId,
            handle: profile?.handle ?? null,
            accountType: profile?.accountType ?? null,
          },
        ];
      }),
    );
  }

  /** Snapshot of who acted — email and role are copied, never joined (see the schema comment). */
  private actor(admin: AdminUserView) {
    return {
      actedByAdminId: admin.id,
      actedByAdminEmail: admin.email,
      actedByAdminRole: admin.role,
    };
  }
}

/**
 * An applicant with no UserProfile row.
 *
 * Not an error and not hidden: the submission exists and still has to be
 * reviewed. Every field is null rather than a plausible default, so the
 * dashboard shows "unknown" instead of inventing a name.
 */
function emptyApplicantView(wawuUserId: string): AdminVerificationApplicantView {
  return { wawuUserId, handle: null, accountType: null };
}

/**
 * The last path segment of a stored document value, with any query string
 * dropped, so the reviewer sees what they are about to open without the
 * response carrying anything that could be used to fetch it.
 *
 * Duplicated from ../kyc-review/admin-kyc-review.service.ts rather than shared.
 * That is the established idiom in this codebase — CreatorAccountGuard is
 * copied verbatim into six resource directories rather than hoisted — and here
 * it also keeps the two review surfaces from acquiring a shared module, which
 * is the first step towards a shared screen.
 */
export function documentFilenameFrom(stored: string | null): string | null {
  if (!stored) return null;
  const withoutQuery = stored.split('?')[0];
  const segment = withoutQuery.split('/').filter(Boolean).pop();
  return segment && segment.length > 0 ? segment : null;
}
