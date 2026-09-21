import type { AdminContentReviewModel } from '../../../generated/prisma/models';
import type {
  AccessType,
  AccountType,
  ContentStatus,
  ContentType,
} from '../../../generated/prisma/enums';

/**
 * The wire shapes for the admin content-review surface.
 *
 * These are ADMIN-ONLY views. `src/common/types/content-piece.type.ts`
 * (ContentPieceResponse) is the shipped app's shape and is neither reused nor
 * widened here — protected-surface hazard H-1 records that it is a bare
 * re-export of the Prisma model returned by spread, so touching it changes
 * what the live app receives.
 *
 * The differences are deliberate, not cosmetic:
 *
 *  - `fullAssetUrl` on the app shape is nulled unless the requester bought
 *    the piece. A reviewer has to watch the paid asset to judge it, so the
 *    admin shape carries it — as a SHORT-LIVED signed URL, never the stored
 *    value (see AdminContentReviewService.signAsset).
 *  - `fullAssetLocked` is a buyer concept and has no meaning here, so it is
 *    absent rather than hardcoded to something untrue.
 *  - the creator block is context the app never returns to anyone.
 */

/**
 * Who uploaded this, and what their gates say.
 *
 * Everything here is read from the same rows the app reads — no second
 * definition of any number is computed (law 13). `slotsTotal` is derived with
 * `uploadAllowanceFor()`, exactly as CreatorStateService does, because it
 * is not a stored column. `kycStatus` reproduces CreatorStateService's
 * `not_started` synthesis (protected-surface hazard H-5) so a reviewer and the
 * creator are looking at the same word for the same state.
 */
export interface AdminContentCreatorView {
  wawuUserId: string;
  handle: string | null;
  accountType: AccountType | null;
  /** ReviewStatus, plus the synthesized 'not_started' — see hazard H-5. Never written back. */
  kycStatus: string | null;
  slotsUsed: number | null;
  slotsTotal: number | null;
}

/**
 * Signed, short-lived read URLs for the two stored assets.
 *
 * `null` means "this could not be signed right now" (storage unconfigured, or
 * no asset stored) — not "there is no asset". Never persisted, never logged.
 */
export interface AdminContentAssetsView {
  previewUrl: string | null;
  fullUrl: string | null;
  /** True when the piece has a stored full asset, whether or not it could be signed. */
  hasFullAsset: boolean;
}

/** One row of the review queue. */
export interface AdminContentQueueItemView {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  contentType: ContentType;
  accessType: AccessType;
  /** Naira, whole units. Rendered ₦ only — never a dollar figure (CLAUDE.md). */
  price: number;
  durationLabel: string | null;
  pageCount: number | null;
  status: ContentStatus;
  creatorFirstUploadFree: boolean;
  createdAt: Date;
  /** Whole hours since upload — how a queue is triaged when it is oldest-first. */
  waitingHours: number;
  creator: AdminContentCreatorView;
  assets: AdminContentAssetsView;
}

/** A lesson of a course piece, as the reviewer sees it. */
export interface AdminContentLessonView {
  id: string;
  title: string;
  order: number;
  durationLabel: string | null;
}

/** One decision from the audit trail. */
export interface AdminContentReviewEntryView {
  id: string;
  decision: AdminContentReviewModel['decision'];
  previousStatus: ContentStatus;
  newStatus: ContentStatus;
  reason: string | null;
  slotReturned: boolean;
  reviewedByAdminId: string;
  reviewedByAdminEmail: string;
  reviewedByAdminRole: AdminContentReviewModel['reviewedByAdminRole'];
  reviewedAt: Date;
}

/** Full detail for one piece. */
export interface AdminContentDetailView extends AdminContentQueueItemView {
  views: number;
  likes: number;
  commentCount: number;
  ratingPct: number | null;
  lessons: AdminContentLessonView[];
  /** Completed purchases. A sold piece is unpublished, never deleted (Purchase.contentId is onDelete: Restrict). */
  completedPurchaseCount: number;
  /** Newest decision first. Empty until this piece has been moderated. */
  reviewHistory: AdminContentReviewEntryView[];
}

/** What approve/reject return. */
export interface AdminContentDecisionView {
  content: AdminContentDetailView;
  review: AdminContentReviewEntryView;
}

export function toAdminContentReviewEntryView(
  row: AdminContentReviewModel,
): AdminContentReviewEntryView {
  return {
    id: row.id,
    decision: row.decision,
    previousStatus: row.previousStatus,
    newStatus: row.newStatus,
    reason: row.reason,
    slotReturned: row.slotReturned,
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedByAdminEmail: row.reviewedByAdminEmail,
    reviewedByAdminRole: row.reviewedByAdminRole,
    reviewedAt: row.reviewedAt,
  };
}
