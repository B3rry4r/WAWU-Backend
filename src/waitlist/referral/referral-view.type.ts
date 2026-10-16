import type { ReferralNotApplied } from './referral-code';

/**
 * What the referral routes answer (REF-01). Naira only: `...Kobo` fields are
 * whole kobo.
 */

/**
 * POST /waitlist/registrations, when a referral code was sent: what became of
 * it. `applied` false means the person registers at the standard price and is
 * not counted under the code; `reason` says why.
 */
export interface WaitlistReferralOutcomeView {
  /** The code, upper case. */
  code: string;
  applied: boolean;
  /** Present only when `applied` is false: `full` (the limit is reached) or `inactive` (switched off). */
  reason?: ReferralNotApplied;
}

/**
 * GET /waitlist/referral-codes/{code}: does this code apply, and what would
 * the person pay. Never the limit, the count or the community.
 */
export interface WaitlistReferralCheckView {
  /** The code, upper case. */
  code: string;
  /** True when a registration started now would be charged the code's price. */
  applies: boolean;
  /** Present only when `applies` is false: `full` or `inactive`. */
  reason?: ReferralNotApplied;
  /** What the person would pay, in whole kobo: the code's price when it applies, the standard price when it does not. 0 means free. */
  priceKobo: number;
}

/** One referral code in the team's list (admin). */
export interface AdminReferralCodeView {
  id: string;
  /** Upper case letters and digits. */
  code: string;
  /** The label the owner tracks by. */
  community: string;
  /** What a person using the code pays, in whole kobo; 0 is free. */
  priceKobo: number;
  /** How many people may use the code; null means no limit. */
  limit: number | null;
  active: boolean;
  /** Paid registrations counted under the code. */
  paidCount: number;
  /** Unpaid registrations started under the code in the last 30 minutes (a held place). */
  heldCount: number;
  /** What those paid registrations paid in all, in whole kobo. */
  paidKobo: number;
  createdAt: string;
  updatedAt: string;
}

/** One row of the split: a code, or the "No code" row (`code` null). */
export interface AdminWaitlistSplitRowView {
  /** The referral code; null for every paid registration with no code, including all made before codes existed. */
  code: string | null;
  /** The code's community; null on the "No code" row. */
  community: string | null;
  /** People who paid. */
  people: number;
  /** What they paid, in whole kobo. */
  kobo: number;
}

/**
 * GET /admin/waitlist/registrations/summary: the whole /join offer, counting
 * every paid registration since it opened, with or without a code.
 */
export interface AdminWaitlistSummaryView {
  /** The offer asked for; null means every offer. */
  offerId: string | null;
  /** Registrations that paid. */
  paid: { people: number; kobo: number };
  /** Second payments kept for a refund: not income, shown apart. */
  failed: { people: number; kobo: number };
  /** Registrations started and not paid (waiting, or abandoned and not yet cleared). */
  unpaid: number;
  /** One row per referral code (even with nobody yet), then the "No code" row last. */
  split: AdminWaitlistSplitRowView[];
  generatedAt: string;
}
