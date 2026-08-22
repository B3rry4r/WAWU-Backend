import type { AdminKycAuditModel } from '../../../generated/prisma/models';
import type { AccountType, CreatorTier, ReviewStatus, SubscriptionStatus } from '../../../generated/prisma/enums';

/**
 * The wire shapes for the admin KYC-review surface — the EARNING gate.
 *
 * Nothing on this file is about the verification-tier ladder. That is a
 * different system with its own module, its own audit table and its own view
 * file (../verification-review/), and CLAUDE.md's non-negotiables plus the
 * derived-surface guardrails both forbid a surface that shows the two
 * together. The vocabulary here is "KYC", "payout eligibility", "earning";
 * the words "verified", "tier" and "badge" do not appear.
 *
 * These are ADMIN-ONLY views. `src/common/types/kyc-submission.type.ts` is the
 * shipped app's shape and is neither reused nor widened — protected-surface
 * hazard H-1 records that it is a bare re-export of the Prisma model returned
 * by spread, so touching it changes what the creator's own `GET /kyc`
 * receives.
 *
 * The differences from the app's shape are deliberate:
 *
 *  - identifiers are named `bvnMasked` / `ninMasked` / … rather than `bvn` /
 *    `nin`. The app returns masked values under the plain names, which means
 *    a client cannot tell a masked value from a real one by looking at the
 *    field. On a surface that ALSO has an unmasking endpoint, that ambiguity
 *    is how a masked string gets keyed into a bank form, or a real BVN gets
 *    rendered into a screenshot. The two spellings never collide.
 *  - `idDocumentUrl` is absent everywhere, at every status. The stored object
 *    key is exchanged for a short-lived signed URL only by
 *    POST /admin/kyc/:id/document-url, one fetch at a time, and every fetch is
 *    an audit row. A URL on the list response would be a bulk disclosure of
 *    government IDs that nobody had to ask for.
 */

/** Identifiers as the queue and the detail screen show them: masked, always. */
export interface AdminKycMaskedIdentifiersView {
  /** Last four digits only, e.g. "•••••••6789". Null when the field is unset. */
  bvnMasked: string | null;
  ninMasked: string | null;
  nationalIdEquivalentMasked: string | null;
  payoutAccountNumberMasked: string | null;
}

/**
 * The creator's gate state, read from the same rows the app reads.
 *
 * `kycStatus` reproduces CreatorStateService's `not_started` synthesis
 * (protected-surface hazard H-5) so a reviewer and the creator are looking at
 * the same word for the same state, and `slotsTotal` is derived with the
 * shared `uploadAllowanceFor(tier)` helper rather than recomputed — law 13,
 * one definition of one number. Nothing here is written back.
 *
 * `subscriptionPaid` is the OTHER gate and is shown for context only:
 * approving KYC must never touch it. "Paid + uploading + KYC pending" is a
 * normal state in this product, not an inconsistency to resolve.
 */
export interface AdminKycCreatorView {
  wawuUserId: string;
  handle: string | null;
  accountType: AccountType | null;
  tier: CreatorTier | null;
  /** GATE 1 — uploading. Displayed, never written by this surface. */
  subscriptionPaid: boolean | null;
  /** GATE 2 — earning. ReviewStatus plus the synthesized 'not_started' (hazard H-5). */
  kycStatus: string | null;
  slotsUsed: number | null;
  slotsTotal: number | null;
  subscriptionStatus: SubscriptionStatus | null;
  subscriptionCurrentPeriodEnd: Date | null;
}

/** One row of the review queue. */
export interface AdminKycQueueItemView {
  id: string;
  wawuUserId: string;
  handle: string | null;
  country: string;
  /**
   * Free text in the database, not an enum: the DTO accepts
   * passport|national_id_card|drivers_licence but live data also holds
   * 'nin_slip' from the seed. Passed through as stored rather than coerced
   * into the DTO's set — the shapes in the data are facts (law 8).
   */
  idDocumentType: string;
  /** True when a document was uploaded at all. The URL is never on this shape. */
  hasIdDocument: boolean;
  /** Last path segment of the stored object key, so the reviewer knows what they are about to open. */
  idDocumentFilename: string | null;
  payoutBankName: string;
  identifiers: AdminKycMaskedIdentifiersView;
  status: ReviewStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  /** Whole hours since submission — how a queue is triaged when it is oldest-first. */
  waitingHours: number;
  /** 1 for a first submission, N for the Nth. Counted across every submission this creator has ever filed. */
  submissionNumber: number;
  /** submissionNumber > 1. A resubmission usually means a reviewer already rejected once. */
  isResubmission: boolean;
}

/** One earlier submission by the same creator. */
export interface AdminKycHistoryEntryView {
  id: string;
  status: ReviewStatus;
  idDocumentType: string;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
}

/** One row of the audit trail — a decision, a document fetch, or an unmasking. */
export interface AdminKycAuditEntryView {
  id: string;
  action: AdminKycAuditModel['action'];
  previousStatus: ReviewStatus | null;
  newStatus: ReviewStatus | null;
  reason: string | null;
  actedByAdminId: string;
  actedByAdminEmail: string;
  actedByAdminRole: AdminKycAuditModel['actedByAdminRole'];
  actedAt: Date;
}

/** Full detail for one submission. */
export interface AdminKycDetailView extends AdminKycQueueItemView {
  creator: AdminKycCreatorView;
  /** Every submission this creator has filed, newest first, including this one. */
  history: AdminKycHistoryEntryView[];
  /** Newest first. Empty until someone has opened, unmasked or decided this submission. */
  auditTrail: AdminKycAuditEntryView[];
}

/** What approve/reject return. */
export interface AdminKycDecisionView {
  submission: AdminKycDetailView;
  audit: AdminKycAuditEntryView;
}

/**
 * What POST /admin/kyc/:id/document-url returns.
 *
 * The URL is handed over and then forgotten: it is never written to a row,
 * never put in the audit trail, and never logged. It is a bearer token for a
 * government ID, and a log line is a place it outlives the request.
 *
 * `signed: false` with a null `expiresInSeconds` is an honest answer, not an
 * error: a handful of legacy rows hold an absolute URL where every current row
 * holds a bare object key, and StorageService returns such a value verbatim
 * rather than signing it. Reporting "900 seconds" over one of those would be a
 * lie about how long the link lives.
 */
export interface AdminKycDocumentUrlView {
  url: string;
  signed: boolean;
  expiresInSeconds: number | null;
  expiresAt: Date | null;
  audit: AdminKycAuditEntryView;
}

/** What POST /admin/kyc/:id/reveal returns — the only unmasked shape on this surface. */
export interface AdminKycRevealView {
  bvn: string | null;
  nin: string | null;
  nationalIdEquivalent: string | null;
  payoutBankName: string;
  payoutAccountNumber: string;
  audit: AdminKycAuditEntryView;
}

export function toAdminKycAuditEntryView(row: AdminKycAuditModel): AdminKycAuditEntryView {
  return {
    id: row.id,
    action: row.action,
    previousStatus: row.previousStatus,
    newStatus: row.newStatus,
    reason: row.reason,
    actedByAdminId: row.actedByAdminId,
    actedByAdminEmail: row.actedByAdminEmail,
    actedByAdminRole: row.actedByAdminRole,
    actedAt: row.actedAt,
  };
}
