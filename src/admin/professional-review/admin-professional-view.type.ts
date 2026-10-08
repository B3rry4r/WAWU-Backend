import type {
  ProfessionalCredentialKind,
  ReviewStatus,
  AccountType,
  AdminRole,
} from '../../../generated/prisma/enums';
import type { ProfessionalListingVisibility } from '../../professional/professional-takedown';

/**
 * The wire shapes for the admin professional-review surface.
 *
 * DECLARED views, not Prisma re-exports — hazard H-1, same rule as
 * admin-event-view.type.ts and admin-content-view.type.ts. It matters
 * particularly here: `ProfessionalProfile` carries a licence number, and a
 * bare re-export returned by spread would put it on any surface that ever
 * widened to a new column.
 *
 * ── WHO SEES THE LICENCE NUMBER ──────────────────────────────────────────
 * A REVIEWER does, because confirming it with the issuing body is the job.
 * A BUYER never does: the public endpoint returns `issuingBody` so someone
 * can check the register themselves, and omits the number, which is an
 * identifier that could be used to impersonate its holder. These types are
 * the admin side of that split and must not be reused on a public surface.
 */

/** One row in the review queue. */
export interface AdminProfessionalQueueItemView {
  id: string;
  wawuId: string;
  /** Display name from WAWU ID, falling back to the id when unresolved. */
  name: string;
  /** An explore category id — `legal_services`, `technology`, … */
  category: string;
  /**
   * True for legal, healthcare, finance and insurance. Drives the reviewer's
   * instruction: in a regulated field the job is to confirm the licence with
   * the body that issued it, not to form a view on the applicant.
   */
  regulated: boolean;
  headline: string;
  credentialKind: ProfessionalCredentialKind;
  licenceNumber: string | null;
  issuingBody: string | null;
  /** How many documents were attached; the URLs are fetched one at a time. */
  documentCount: number;
  status: ReviewStatus;
  submittedAt: Date;
  /** Hours this applicant has been waiting. The queue's real priority. */
  waitingHours: number;
}

/** Another field the same applicant has applied in. */
export interface AdminProfessionalOtherCategoryView {
  category: string;
  status: ReviewStatus;
}

/** One application in full — everything a decision rests on. */
export interface AdminProfessionalDetailView {
  id: string;
  wawuId: string;
  name: string;
  handle: string | null;
  bio: string | null;
  accountType: AccountType | null;
  /** Their badge tier BEFORE this decision. */
  currentVerification: string;
  category: string;
  regulated: boolean;
  headline: string;
  about: string;
  services: string[];
  credentialKind: ProfessionalCredentialKind;
  licenceNumber: string | null;
  issuingBody: string | null;
  /** Object keys. Exchanged one at a time for a short-lived signed URL. */
  documents: string[];
  status: ReviewStatus;
  rejectionReason: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  /**
   * Other fields this person has applied in. A reviewer seeing a fifth
   * unrelated speciality from one applicant should notice without going and
   * looking for it.
   */
  otherCategories: AdminProfessionalOtherCategoryView[];
}

/** A short-lived signed URL for one uploaded document. */
export interface AdminProfessionalDocumentUrlView {
  url: string;
}

/** What a decision returns. */
export interface AdminProfessionalDecisionView {
  id: string;
  status: ReviewStatus;
  rejectionReason: string | null;
  reviewedAt: Date | null;
  listed: boolean;
}

/**
 * The latest admin takedown on record for one listing (FIX-06), standing or
 * lifted. Admin email and role are the snapshots taken when it happened.
 */
export interface AdminProfessionalTakedownRecordView {
  /** True while it stands: the owner cannot show the listing. */
  standing: boolean;
  takenDownAt: Date;
  takenDownByAdminId: string;
  takenDownByAdminEmail: string;
  takenDownByAdminRole: AdminRole;
  /**
   * What a relist puts back: `listed` (back in the directory) or `hidden`
   * (the owner had hidden it themselves, before or during the takedown).
   */
  relistsAs: 'listed' | 'hidden';
  /** All null while it stands. */
  liftedAt: Date | null;
  liftedByAdminId: string | null;
  liftedByAdminEmail: string | null;
  liftedByAdminRole: AdminRole | null;
}

/**
 * GET /admin/professionals/:id/visibility (FIX-06): whether a listing is in
 * the directory, hidden by its owner, or taken down by an admin, so the
 * dashboard knows when to offer "List again". A new route: the protected
 * queue and detail answers are not widened.
 */
export interface AdminProfessionalVisibilityView {
  id: string;
  status: ReviewStatus;
  /**
   * `listed`, `hidden` (by its owner) or `taken_down` (by an admin). Null for
   * an application that is not approved and has no takedown standing: it is
   * not a listing yet.
   */
  visibility: ProfessionalListingVisibility | null;
  /** When the standing takedown was made. Null when none stands. */
  takenDownAt: Date | null;
  /** The latest takedown on record. Null when there has never been one. */
  latestTakedown: AdminProfessionalTakedownRecordView | null;
}
