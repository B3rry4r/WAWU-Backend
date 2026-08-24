import type {
  ProfessionalCredentialKind,
  ReviewStatus,
  AccountType,
} from '../../../generated/prisma/enums';

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
