import type { VerificationState } from '../../common/verification/verification-state';
import type {
  AccountType,
  ReviewStatus,
  VerificationTier,
} from '../../../generated/prisma/enums';

/**
 * The wire shapes for the admin creator-lookup surface — the screen an
 * operator opens when a creator emails "I paid and I cannot upload".
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * There was no creator lookup of any kind. Every existing read is self-scoped
 * (`/creator`, `/content/mine/earnings` all key on
 * the caller's own token), so an operator holding a support ticket had nothing
 * to open — not by handle, not by id, not at all. The answer to that ticket is
 * spread across four tables and one derived figure, and nobody could see them
 * together.
 *
 * ── WHY THESE ARE ADMIN-ONLY VIEWS ───────────────────────────────────────
 * Protected-surface hazard H-1: nearly every wire type in this codebase is a
 * bare re-export of its Prisma model returned by spread, so a new column on an
 * existing table silently widens a live app response. Nothing here reuses or
 * widens `src/common/types/creator-state.type.ts`; these interfaces are
 * declared field by field so a future column reaches this surface only when
 * somebody decides it should.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────
 * BVN, NIN, national-ID equivalent, ID document URL, payout bank name and
 * payout account number. None of them appear on any shape in this file and
 * none is selected by the service. `kycStatus` is a five-letter lifecycle word
 * carrying no PII, which is why support may read this surface at all; the
 * documents behind that word live in `../kyc-review/`, where support is
 * refused. The two must not converge here by accident, so the KYC block on
 * this surface is dates and a status and nothing else.
 */

/**
 * The EARNING gate.
 *
 * There were two gates. A paid subscription unlocked UPLOADING and manual KYC
 * unlocks EARNING; the first went with subscriptions, and uploading is now
 * bounded only by the per-account cap (5 uploads, 25 with a tick, R-7). KYC
 * is untouched. There is still
 * no `verified` boolean on this shape and there never will be one — collapsing
 * a KYC status into a single word is how a creator who cannot be paid gets
 * told everything is fine.
 */
export interface AdminCreatorGatesView {
  /**
   * The EARNING gate. `CreatorState.kycStatus`, plus the `not_started`
   * synthesis `CreatorStateService` performs (protected-surface hazard H-5):
   * the column defaults to `pending`, so a creator who has never submitted
   * anything and a creator waiting on a reviewer are the same row. The app
   * already distinguishes them for the creator's own screen; reproducing it
   * here is what stops an operator and a creator using different words for the
   * same state. Null when there is no CreatorState row.
   */
  kycStatus: ReviewStatus | 'not_started' | null;
  /** When the most recent KYC submission was made. Null if there has never been one. */
  kycSubmittedAt: Date | null;
  /** When a reviewer last acted on it. Null while it is still waiting. */
  kycReviewedAt: Date | null;
  /**
   * Why the latest submission was rejected, if it was. This is a reviewer's
   * own free-text reason, not document data.
   */
  kycRejectionReason: string | null;
}

/**
 * The public trust badge — its OWN field, never mixed with `kycStatus`.
 *
 * These are independent systems by product rule (CLAUDE.md: "Creator is an
 * ACCOUNT TYPE, not a trust-tier badge"), and the shipped app has already
 * conflated them once in copy.
 *
 * ── WHERE THE NUMBER COMES FROM, HONESTLY ────────────────────────────────
 * WAWU ID owns `verificationTier`. This backend stores no tier column at all:
 * it owns the submission/review workflow and pushes an approved tier back over
 * `WawuIdClient.elevateVerificationTier`, and the value the app renders comes
 * off the user's WAWU ID token claim. So the honest answer this backend can
 * give is "the last rung THIS backend approved", which is what `approvedTier`
 * is — not a second definition of the badge, and labelled as such by
 * `authority`.
 */
export interface AdminCreatorVerificationView {
  /**
   * The two ticks, as everybody else on the platform sees them.
   *
   * THIS is the live badge now, and the three tier fields below it are the
   * history of the ladder it replaced. They are kept because a submission
   * made before the change is still a real thing a reviewer may have to
   * explain, and removing them would leave an admin looking at a decision
   * with no record of what was decided. Read this field, not those.
   */
  ticks: VerificationState;
  /** The highest rung this backend has approved and elevated. Null if none. */
  approvedTier: VerificationTier | null;
  /** When that approval happened. */
  approvedAt: Date | null;
  /** A rung currently waiting on a reviewer, if any. */
  pendingTier: VerificationTier | null;
  /**
   * Always `'wawu-id'`. Present so a dashboard cannot render `approvedTier` as
   * if this backend were the source of truth for the badge: if the tier was
   * changed at WAWU ID out of band, this field is what says where to look.
   */
  authority: 'wawu-id';
}

/** Upload slots. `slotsTotal` is derived, never stored — see `uploadAllowanceFor`. */
export interface AdminCreatorUploadsView {
  slotsUsed: number | null;
  /**
   * The per-account cap, from the shared `uploadAllowanceFor()` helper and
   * the creator's tick (R-7: 5, or 25 with a tick), exactly as
   * CreatorStateService derives it. There is no free/paid sub-split.
   */
  slotsTotal: number | null;
  /** Pieces currently waiting on a moderator — the other reason "I cannot see my upload". */
  pendingReviewCount: number;
  liveCount: number;
}

/**
 * Earnings, read from `CreatorEarningsService` — the SAME service that answers
 * the creator's own `/content/mine/earnings`.
 *
 * Not recomputed here. Two definitions of one number is how a support agent
 * and a creator end up looking at different money on the same phone call, and
 * the commission maths involved (per-row snapshotted rates, credit cost-basis
 * in kobo, DM escrow) is precisely the kind that drifts when copied.
 *
 * Naira, always. These are read-time aggregates, not a spendable ledger.
 */
export interface AdminCreatorEarningsView {
  total: number;
  payable: number;
  held: number;
}

/** One row of the lookup results. */
export interface AdminCreatorListItemView {
  wawuUserId: string;
  handle: string | null;
  accountType: AccountType;
  gates: AdminCreatorGatesView;
  createdAt: Date;
}

/**
 * One creator in full — everything the support screen needs, in one response.
 *
 * `accountType` and `createdAt` are nullable here and not on the list shape,
 * because they are the only two fields that come from `UserProfile` and the
 * detail endpoint can be opened for an account that has none. That is not
 * hypothetical: every CreatorAccountGuard in the codebase reads `accountType`
 * off the profile, so an account with a CreatorState row and no profile is
 * 403'd everywhere. That broken shape is exactly the ticket this screen exists
 * for, so it must open rather than 404.
 */
export interface AdminCreatorDetailView {
  wawuUserId: string;
  handle: string | null;
  accountType: AccountType | null;
  createdAt: Date | null;
  gates: AdminCreatorGatesView;
  verification: AdminCreatorVerificationView;
  uploads: AdminCreatorUploadsView;
  earnings: AdminCreatorEarningsView;
  /** Whether paid DMs are switched on, and at what price. Naira. */
  directMessages: { enabled: boolean | null; price: number | null };
}
