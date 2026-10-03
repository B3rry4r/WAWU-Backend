import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { KycSubmissionService } from '../../kyc-submission/kyc-submission.service';
import { holdsTick, uploadAllowanceFor } from '../../common/creator-allowance';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { AdminKycAuditModel, KycSubmissionModel } from '../../../generated/prisma/models';
import type { AdminUserView } from '../auth/admin-user-view.type';
import {
  toAdminKycAuditEntryView,
  type AdminKycCreatorView,
  type AdminKycDecisionView,
  type AdminKycDetailView,
  type AdminKycDocumentUrlView,
  type AdminKycQueueItemView,
  type AdminKycRevealView,
} from './admin-kyc-view.type';
import type { AdminKycQueueQueryDto } from './dto/admin-kyc-queue-query.dto';
import type { RejectKycDto } from './dto/reject-kyc.dto';

/**
 * A government ID gets the shortest URL StorageService offers — the same
 * 900-second path the creator's own `GET /kyc` uses, never `readUrlFor`, whose
 * URLs live for seven days.
 */
const SIGNED_URL_TTL_SECONDS = 900;

const MS_PER_HOUR = 3_600_000;

/** The one upload destination KYC documents are written to (storage/dto/presign-upload.dto.ts). */
const KYC_DOCUMENT_FOLDER = 'kyc/id-document';

/**
 * The reviewer's side of the EARNING gate.
 *
 * `POST /kyc/:id/review` has existed since the original build and is guarded —
 * but nothing in this backend ever listed submissions, so a reviewer had no
 * way to discover a submission id. `KycSubmissionService.getMine()` is
 * `where: { wawuUserId }` and there is no other read. The consequence is not
 * subtle: CreatorState.kycStatus is GATE 2, the gate on being paid, and its
 * only writer of `approved` is that unreachable route. No creator on this
 * platform could ever be cleared to earn. This module is the queue that makes
 * the existing route reachable.
 *
 * ── WHAT THIS SERVICE DOES NOT DO ────────────────────────────────────────
 * It does not implement the review transition. `approve` and `reject`
 * delegate to the EXISTING `KycSubmissionService.review()` — the same method,
 * unmodified, that `POST /kyc/:id/review` calls. That service is listed in
 * this module's providers (a second instance of a stateless class), not
 * imported through KycSubmissionModule, which exports nothing; no existing
 * file is edited to make it reachable.
 *
 * Delegating rather than reimplementing is the whole point: a second copy of
 * "only a pending submission may be reviewed, a rejection needs a reason,
 * CreatorState.kycStatus follows the decision" would drift from the shipped
 * one, and the shipped one is what the creator's own screen reflects. Two
 * definitions of one gate is how a creator and a reviewer end up looking at
 * different realities (law 13).
 *
 * This service owns everything around that call: the queue, the evidence, the
 * masking, the short-lived document URLs, and the audit trail.
 */
@Injectable()
export class AdminKycReviewService {
  private readonly logger = new Logger(AdminKycReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly kyc: KycSubmissionService,
  ) {}

  /**
   * GET /admin/kyc/queue — everything waiting on a human, oldest first.
   *
   * Only `pending`, and only masked identifiers. The full row, the history and
   * the audit trail all live behind the detail endpoint, so working the queue
   * does not put every creator's bank details on one screen.
   */
  async queue(query: AdminKycQueueQueryDto): Promise<Paginated<AdminKycQueueItemView>> {
    const where = { status: 'pending' as const };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.kycSubmission.findMany({
        where,
        orderBy: { submittedAt: query.sort === 'newest' ? 'desc' : 'asc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.kycSubmission.count({ where }),
    ]);

    const wawuUserIds = rows.map((r) => r.wawuUserId);
    const [ordinals, handles] = await Promise.all([
      this.resolveSubmissionOrdinals(wawuUserIds),
      this.resolveHandles(wawuUserIds),
    ]);

    return {
      items: rows.map((row) =>
        this.toQueueItem(row, ordinals.get(row.id) ?? 1, handles.get(row.wawuUserId) ?? null),
      ),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /** GET /admin/kyc/:id — any status, so a reviewer can revisit a decision they already made. */
  async detail(id: string): Promise<AdminKycDetailView> {
    return this.toDetail(await this.require(id));
  }

  /**
   * POST /admin/kyc/:id/document-url — exchange the stored object key for a
   * short-lived signed GET.
   *
   * POST, not GET, precisely so it is a recorded action rather than a
   * cacheable read: every call writes a `document_viewed` audit row naming the
   * admin who opened a government ID. The URL is returned and forgotten —
   * never persisted, never logged, never echoed into the audit row.
   */
  async documentUrl(id: string, admin: AdminUserView): Promise<AdminKycDocumentUrlView> {
    const submission = await this.require(id);
    if (!submission.idDocumentUrl) {
      throw new NotFoundException('This submission has no ID document.');
    }

    const stored = submission.idDocumentUrl;
    const key = kycObjectKeyFrom(stored);
    // StorageService returns an absolute URL verbatim instead of signing it.
    // Current rows hold a bare key; a few legacy rows hold a URL, and saying
    // "expires in 900s" over one of those would be false.
    const isAbsolute = key.startsWith('http://') || key.startsWith('https://');
    const url = await this.storage.signedReadUrl(key, SIGNED_URL_TTL_SECONDS);

    const audit = await this.prisma.adminKycAudit.create({
      data: {
        submissionId: submission.id,
        subjectWawuUserId: submission.wawuUserId,
        action: 'document_viewed',
        ...this.actor(admin),
      },
    });

    return {
      url,
      signed: !isAbsolute,
      expiresInSeconds: isAbsolute ? null : SIGNED_URL_TTL_SECONDS,
      expiresAt: isAbsolute ? null : new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000),
      audit: toAdminKycAuditEntryView(audit),
    };
  }

  /**
   * POST /admin/kyc/:id/reveal — the unmasked BVN, NIN and payout account.
   *
   * This exists because the review it supports is not a rubber stamp: a
   * reviewer has to key the identifiers into a bank or NIBSS check, and last
   * four digits cannot be checked against anything. Masked-only would have
   * produced approvals that verified nothing, which is worse than the
   * disclosure — the disclosure at least leaves a row saying who saw what and
   * when.
   *
   * Audited on every call, restricted to the two roles that can also decide,
   * and deliberately a separate endpoint from the detail read so that opening
   * a file is not the same act as unmasking it.
   */
  async reveal(id: string, admin: AdminUserView): Promise<AdminKycRevealView> {
    const submission = await this.require(id);

    const audit = await this.prisma.adminKycAudit.create({
      data: {
        submissionId: submission.id,
        subjectWawuUserId: submission.wawuUserId,
        action: 'identifiers_revealed',
        ...this.actor(admin),
      },
    });

    return {
      bvn: submission.bvn,
      nin: submission.nin,
      nationalIdEquivalent: submission.nationalIdEquivalent,
      payoutBankName: submission.payoutBankName,
      payoutAccountNumber: submission.payoutAccountNumber,
      audit: toAdminKycAuditEntryView(audit),
    };
  }

  /**
   * POST /admin/kyc/:id/approve — the creator can be paid.
   *
   * Flips CreatorState.kycStatus to `approved` through the existing service,
   * which is what `GET /creator/state` reads. It touches the earning gate
   * only: accountType and the WAWU ID verification tier are untouched, here
   * and everywhere else in this module.
   */
  async approve(id: string, admin: AdminUserView): Promise<AdminKycDecisionView> {
    return this.decide(id, admin, 'approved', null);
  }

  /** POST /admin/kyc/:id/reject — reason required, and the creator is shown it. */
  async reject(id: string, dto: RejectKycDto, admin: AdminUserView): Promise<AdminKycDecisionView> {
    return this.decide(id, admin, 'rejected', dto.reason.trim());
  }

  /**
   * The status the submission held before the decision has to be read first —
   * the existing service returns only the updated row, and an audit trail that
   * cannot say what changed is a log, not a trail.
   *
   * The read and the delegated write are not one transaction, and cannot be
   * without editing KycSubmissionService. The exposure is the same one the
   * shipped `POST /kyc/:id/review` already carries: two reviewers acting in the
   * same instant both read `pending`, and the second call's own re-read inside
   * review() refuses it. Since the refusal throws before this method reaches
   * the audit write, the losing reviewer produces no row.
   */
  private async decide(
    id: string,
    admin: AdminUserView,
    decision: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<AdminKycDecisionView> {
    const before = await this.require(id);

    // The EXISTING review path, unmodified: same validation, same
    // CreatorState.kycStatus write, same error messages the app's own
    // reviewers already see.
    const updated = await this.kyc.review(id, {
      decision,
      rejectionReason: reason ?? undefined,
    });

    const audit = await this.prisma.adminKycAudit.create({
      data: {
        submissionId: id,
        subjectWawuUserId: before.wawuUserId,
        action: decision,
        previousStatus: before.status,
        newStatus: decision,
        reason,
        ...this.actor(admin),
      },
    });

    return {
      submission: await this.toDetail(updated as KycSubmissionModel),
      audit: toAdminKycAuditEntryView(audit),
    };
  }

  // ── views ────────────────────────────────────────────────────────────────

  private async require(id: string): Promise<KycSubmissionModel> {
    const submission = await this.prisma.kycSubmission.findUnique({ where: { id } });
    if (!submission) {
      // Same wording as KycSubmissionService.review()'s own 404, so the admin
      // route and the route it delegates to answer identically.
      throw new NotFoundException('KYC submission not found');
    }
    return submission;
  }

  private async toDetail(submission: KycSubmissionModel): Promise<AdminKycDetailView> {
    const [ordinals, handles, creator, history, auditTrail] = await Promise.all([
      this.resolveSubmissionOrdinals([submission.wawuUserId]),
      this.resolveHandles([submission.wawuUserId]),
      this.resolveCreator(submission.wawuUserId),
      this.prisma.kycSubmission.findMany({
        where: { wawuUserId: submission.wawuUserId },
        orderBy: { submittedAt: 'desc' },
      }),
      this.prisma.adminKycAudit.findMany({
        where: { submissionId: submission.id },
        orderBy: { actedAt: 'desc' },
      }),
    ]);

    return {
      ...this.toQueueItem(
        submission,
        ordinals.get(submission.id) ?? 1,
        handles.get(submission.wawuUserId) ?? null,
      ),
      creator,
      history: history.map((row) => ({
        id: row.id,
        status: row.status,
        idDocumentType: row.idDocumentType,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
        rejectionReason: row.rejectionReason,
      })),
      auditTrail: auditTrail.map((row: AdminKycAuditModel) => toAdminKycAuditEntryView(row)),
    };
  }

  private toQueueItem(
    submission: KycSubmissionModel,
    submissionNumber: number,
    handle: string | null,
  ): AdminKycQueueItemView {
    return {
      id: submission.id,
      wawuUserId: submission.wawuUserId,
      handle,
      country: submission.country,
      idDocumentType: submission.idDocumentType,
      hasIdDocument: Boolean(submission.idDocumentUrl),
      idDocumentFilename: documentFilenameFrom(submission.idDocumentUrl),
      payoutBankName: submission.payoutBankName,
      identifiers: {
        bvnMasked: maskTail(submission.bvn),
        ninMasked: maskTail(submission.nin),
        nationalIdEquivalentMasked: maskTail(submission.nationalIdEquivalent),
        payoutAccountNumberMasked: maskTail(submission.payoutAccountNumber),
      },
      status: submission.status,
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt,
      rejectionReason: submission.rejectionReason,
      waitingHours: Math.max(
        0,
        Math.floor((Date.now() - submission.submittedAt.getTime()) / MS_PER_HOUR),
      ),
      submissionNumber,
      isResubmission: submissionNumber > 1,
    };
  }

  /**
   * "Is this a resubmission, and the how-many-th?" — answered in one batched
   * read for the whole page rather than a count per row.
   *
   * KycSubmission keeps history: `submit()` writes a new row rather than
   * updating the old one, so a creator rejected twice has three. A reviewer
   * seeing "submission 3" reads the file differently from "submission 1", and
   * the earlier rejections are on the detail screen's history.
   */
  private async resolveSubmissionOrdinals(wawuUserIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(wawuUserIds)];
    if (ids.length === 0) return new Map();

    const all = await this.prisma.kycSubmission.findMany({
      where: { wawuUserId: { in: ids } },
      select: { id: true, wawuUserId: true },
      orderBy: { submittedAt: 'asc' },
    });

    const seen = new Map<string, number>();
    const ordinals = new Map<string, number>();
    for (const row of all) {
      const next = (seen.get(row.wawuUserId) ?? 0) + 1;
      seen.set(row.wawuUserId, next);
      ordinals.set(row.id, next);
    }
    return ordinals;
  }

  private async resolveHandles(wawuUserIds: string[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(wawuUserIds)];
    if (ids.length === 0) return new Map();
    const profiles = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: ids } },
      select: { wawuUserId: true, handle: true },
    });
    return new Map(profiles.map((p) => [p.wawuUserId, p.handle]));
  }

  /**
   * Gate state for the creator behind one submission.
   *
   * Every value is read from the row the app itself reads, and `kycStatus`
   * reproduces CreatorStateService's `not_started` synthesis (hazard H-5) —
   * the reviewer must see the same word the creator sees on their own screen.
   * A creator with no CreatorState row is not an error and not hidden: the
   * submission exists and still has to be reviewed, so every field comes back
   * null rather than as a plausible default.
   */
  private async resolveCreator(wawuUserId: string): Promise<AdminKycCreatorView> {
    const [profile, state, submissionCount] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { wawuUserId } }),
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
    ]);

    return {
      wawuUserId,
      handle: profile?.handle ?? null,
      accountType: profile?.accountType ?? null,
      kycStatus: state
        ? state.kycStatus === 'pending' && submissionCount === 0
          ? 'not_started'
          : state.kycStatus
        : null,
      slotsUsed: state?.slotsUsed ?? null,
      slotsTotal: state ? uploadAllowanceFor(holdsTick(profile)).total : null,
    };
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
 * Keeps the last four characters, masks the rest: "22123456789" -> "•••••••6789".
 *
 * A verbatim copy of the helper in kyc-submission.service.ts, which is
 * module-private there. Copied rather than hoisted for two reasons: hoisting
 * means editing an existing file, which this module may not do, and the
 * reviewer must see the SAME string the creator sees on their own KYC screen —
 * a second masking rule would make the two screens disagree about a number
 * neither of them is allowed to read in full.
 */
export function maskTail(value: string | null): string | null {
  if (!value || value.length <= 4) return value;
  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Recovers the object key from whatever `idDocumentUrl` holds.
 *
 * The protected registry records that KYC stores a BARE OBJECT KEY, unlike
 * content, which persists `presignUpload().fileUrl` — an absolute,
 * already-signed, seven-day URL. So the common case needs no work and the
 * value is signed as-is.
 *
 * The exception is legacy rows (the seed writes
 * `https://storage.seed.local/kyc/...`). `signedReadUrl` returns any `http(s)`
 * input verbatim, so those cannot be re-signed and the caller is told so
 * (`signed: false`) rather than being promised a 900-second link that is
 * actually a permanent one. Where the URL does carry the known upload prefix —
 * `kyc/id-document/<wawuId>/<uuid>.<ext>`, a closed, server-generated grammar
 * from storage.service.ts — the key is recovered and signed properly. Nothing
 * stored is ever rewritten.
 */
export function kycObjectKeyFrom(stored: string): string {
  if (!stored.startsWith('http://') && !stored.startsWith('https://')) return stored;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(stored).pathname);
  } catch {
    return stored;
  }

  const marker = `/${KYC_DOCUMENT_FOLDER}/`;
  const at = pathname.indexOf(marker);
  return at === -1 ? stored : pathname.slice(at + 1);
}

/**
 * The last path segment of the stored value, with any query string dropped.
 *
 * The reviewer sees what they are about to open (`a1b2….pdf`) without the
 * response carrying anything that could be used to fetch it. Returns null
 * rather than a guess when the value has no recognisable segment.
 */
export function documentFilenameFrom(stored: string | null): string | null {
  if (!stored) return null;
  const withoutQuery = stored.split('?')[0];
  const segment = withoutQuery.split('/').filter(Boolean).pop();
  return segment && segment.length > 0 ? segment : null;
}
