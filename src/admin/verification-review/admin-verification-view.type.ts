import type { AdminVerificationAuditModel } from '../../../generated/prisma/models';
import type { AccountType, ReviewStatus, VerificationTier } from '../../../generated/prisma/enums';

/**
 * The wire shapes for the admin verification-TIER review surface — the public
 * trust badge, and NOT the earning gate.
 *
 * Nothing on this file is about KYC. The words "KYC", "payout", "earning",
 * "BVN" and "NIN" do not appear on this surface at all, and there is no field
 * here that could be mistaken for one: CLAUDE.md lists the two as independent
 * gates, and the shipped app already described "Government ID submitted and
 * approved by hand" on a rung of this ladder once. The earning gate lives in
 * ../kyc-review/, behind different routes and a different audit table.
 *
 * These are ADMIN-ONLY views. `src/common/types/verification-submission.type.ts`
 * is the shipped app's shape and is neither reused nor widened —
 * protected-surface hazard H-1 records that it is a bare re-export of the
 * Prisma model returned by spread.
 *
 * The one substantive difference from the app's shape: `documents` is NOT the
 * stored string array. The app hands a submitter back their own document
 * references; an admin surface handing an operator a list of raw stored values
 * would be handing out whatever those values are, and some of them are
 * long-lived signed URLs. Here the array becomes an index and a filename, and
 * the only way to reach the bytes is the audited signed-URL endpoint.
 */

/** One submitted document, described without disclosing how to fetch it. */
export interface AdminVerificationDocumentView {
  /** Position in VerificationSubmission.documents — what document-url takes. */
  index: number;
  /** Last path segment of the stored value, query string dropped. Null when unrecognisable. */
  filename: string | null;
}

/** Who applied, as context on the queue. */
export interface AdminVerificationApplicantView {
  wawuUserId: string;
  handle: string | null;
  accountType: AccountType | null;
}

/** One row of the review queue. */
export interface AdminVerificationQueueItemView {
  id: string;
  /** The rung applied for: basic → verified_user → verified_business → certified_professional → trusted_partner. */
  tier: VerificationTier;
  status: ReviewStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  /** Whole hours since submission — how a queue is triaged when it is oldest-first. */
  waitingHours: number;
  documentCount: number;
  applicant: AdminVerificationApplicantView;
}

/** One earlier submission by the same applicant. */
export interface AdminVerificationHistoryEntryView {
  id: string;
  tier: VerificationTier;
  status: ReviewStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
}

/** One row of the audit trail — a decision or a document fetch. */
export interface AdminVerificationAuditEntryView {
  id: string;
  action: AdminVerificationAuditModel['action'];
  previousStatus: ReviewStatus | null;
  newStatus: ReviewStatus | null;
  reason: string | null;
  documentIndex: number | null;
  /** True only on an approval that actually reached WAWU ID. */
  tierElevatedAtWawuId: boolean;
  actedByAdminId: string;
  actedByAdminEmail: string;
  actedByAdminRole: AdminVerificationAuditModel['actedByAdminRole'];
  actedAt: Date;
}

/** Full detail for one submission. */
export interface AdminVerificationDetailView extends AdminVerificationQueueItemView {
  documents: AdminVerificationDocumentView[];
  /** Every submission this applicant has filed, newest first, including this one. */
  history: AdminVerificationHistoryEntryView[];
  /** Newest first. Empty until someone has opened a document or decided. */
  auditTrail: AdminVerificationAuditEntryView[];
}

/** What approve/reject return. */
export interface AdminVerificationDecisionView {
  submission: AdminVerificationDetailView;
  audit: AdminVerificationAuditEntryView;
}

/**
 * What POST /admin/verification/:id/document-url returns.
 *
 * Same treatment as a KYC document: short-lived, never persisted, never
 * logged, one fetch per audit row. These are business registrations and
 * professional certificates — not a government ID, but not a public file
 * either.
 *
 * `signed: false` with a null `expiresInSeconds` is an honest answer, not an
 * error: `documents` is a free-text String[] the client fills in, so some rows
 * hold absolute URLs that StorageService returns verbatim rather than signing.
 * Reporting "900 seconds" over one of those would be a lie about how long the
 * link lives.
 */
export interface AdminVerificationDocumentUrlView {
  index: number;
  url: string;
  signed: boolean;
  expiresInSeconds: number | null;
  expiresAt: Date | null;
  audit: AdminVerificationAuditEntryView;
}

export function toAdminVerificationAuditEntryView(
  row: AdminVerificationAuditModel,
): AdminVerificationAuditEntryView {
  return {
    id: row.id,
    action: row.action,
    previousStatus: row.previousStatus,
    newStatus: row.newStatus,
    reason: row.reason,
    documentIndex: row.documentIndex,
    tierElevatedAtWawuId: row.tierElevatedAtWawuId,
    actedByAdminId: row.actedByAdminId,
    actedByAdminEmail: row.actedByAdminEmail,
    actedByAdminRole: row.actedByAdminRole,
    actedAt: row.actedAt,
  };
}
