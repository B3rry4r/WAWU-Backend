/**
 * THE ONE PLACE A TICK IS DECIDED.
 *
 * `verified` is computed on the server, from the expiry, and nowhere else. A
 * client that compared dates itself would draw a tick on a lapsed account for
 * as long as its clock disagreed with ours, and every surface would have to
 * get the same comparison right independently. So the wire carries a boolean
 * and this file is the only thing that produces it.
 *
 * Two ticks, INDEPENDENT of each other:
 *
 *   creator      purple   NGN 4,999 / year
 *   professional green    NGN 9,999 / year
 *
 * They are not a ladder and not ordered. Somebody may hold both, because
 * somebody may be both, and both ticks then render. Nothing here picks a
 * winner or collapses them into a single badge, and anything that sorts the
 * two kinds has reintroduced the five-rung ladder this replaced.
 *
 * The rule, once:
 *
 *     verified = verifiedAt != null && (verifiedUntil == null || verifiedUntil > now)
 *
 * `verifiedUntil == null` alongside a non-null `verifiedAt` is a PERPETUAL
 * tick, granted by an admin. That is what the accounts grandfathered off the
 * old ladder carry. `verifiedAt == null` is simply never verified.
 */

/** One tick, as every user-shaped response carries it. */
export interface TickState {
  verified: boolean;
  /** ISO 8601, or null for a perpetual tick and for one never granted. */
  expiresAt: string | null;
}

/** Both ticks. Every user on the wire carries exactly this. */
export interface VerificationState {
  /** Purple. */
  creator: TickState;
  /** Green. */
  professional: TickState;
}

/** Which tick. Never ordered, never compared for rank. */
export type VerificationKindValue = 'creator' | 'professional';

export const VERIFICATION_KINDS: readonly VerificationKindValue[] = [
  'creator',
  'professional',
] as const;

/**
 * The four stored columns, as Prisma hands them back. Declared structurally
 * rather than importing UserProfileModel so that any row carrying these four
 * dates can be derived from, including a `select` that reads only them.
 */
export interface VerificationColumns {
  creatorVerifiedAt: Date | null;
  creatorVerifiedUntil: Date | null;
  professionalVerifiedAt: Date | null;
  professionalVerifiedUntil: Date | null;
}

function tick(
  verifiedAt: Date | null,
  verifiedUntil: Date | null,
  now: Date,
): TickState {
  if (verifiedAt === null) {
    // Never granted. `expiresAt` is null and `verified` is false, which is a
    // different thing from a perpetual tick even though both carry a null
    // date - the boolean is what tells them apart.
    return { verified: false, expiresAt: null };
  }
  if (verifiedUntil === null) {
    // Perpetual, admin-granted.
    return { verified: true, expiresAt: null };
  }
  return {
    verified: verifiedUntil.getTime() > now.getTime(),
    // The date is reported whether or not it has passed. A client showing
    // "expired on 4 March" needs the date as much as one showing "renews on
    // 4 March", and withholding it once it lapses leaves the person with no
    // way to know what happened.
    expiresAt: verifiedUntil.toISOString(),
  };
}

/**
 * Turn the four stored columns into the wire shape.
 *
 * `now` is injectable so a test can stand at a chosen instant rather than
 * write dates relative to the clock and hope.
 */
export function deriveVerificationState(
  row: VerificationColumns | null | undefined,
  now: Date = new Date(),
): VerificationState {
  if (!row) return unverified();
  return {
    creator: tick(row.creatorVerifiedAt, row.creatorVerifiedUntil, now),
    professional: tick(
      row.professionalVerifiedAt,
      row.professionalVerifiedUntil,
      now,
    ),
  };
}

/**
 * What an account the Hub has no profile row for carries.
 *
 * A function rather than a shared constant: the objects are handed straight
 * to callers that may serialise, freeze or (wrongly) mutate them, and one
 * frozen singleton shared across every response is a bug waiting for the
 * first caller that assigns to it.
 */
export function unverified(): VerificationState {
  return {
    creator: { verified: false, expiresAt: null },
    professional: { verified: false, expiresAt: null },
  };
}

/** True when either tick is currently held. Used by the event-hosting gate. */
export function holdsAnyTick(state: VerificationState): boolean {
  return state.creator.verified || state.professional.verified;
}

/**
 * One year from `from`, which is the term both ticks are sold in.
 *
 * Calendar year, not 365 days, so a purchase on 29 February lands on 1 March
 * rather than drifting a day every leap year. A renewal extends from the
 * later of "now" and the current expiry, so renewing early does not throw
 * away the time already paid for - that decision is the caller's, and this
 * only does the arithmetic.
 */
export function oneYearFrom(from: Date): Date {
  const until = new Date(from.getTime());
  until.setUTCFullYear(until.getUTCFullYear() + 1);
  return until;
}
