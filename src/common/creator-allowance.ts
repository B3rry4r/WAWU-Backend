import {
  deriveVerificationState,
  holdsAnyTick,
  type VerificationColumns,
} from './verification/verification-state';

/**
 * What an account may publish and store.
 *
 * Both limits derive from one fact: whether the account holds a verification
 * tick right now. R-7 (owner, DECISIONS.md in the mobile repo, confirmed and
 * not provisional): "Free accounts: 5 uploads and 1 GB. With a tick: 25
 * uploads, 10 GB and more reach."
 *
 * Either tick counts, creator or professional, and holding both gives the
 * same allowance as holding one: the ticks are independent and never ranked
 * (verification-state.ts), so neither may buy more than the other.
 *
 * The limits are only ever checked when something NEW is uploaded. A piece
 * or a file already stored is never removed or hidden because the account is
 * now above its allowance (a tick that lapsed, or the 1 GB that replaced 2 GB
 * for free accounts): the next upload is refused, nothing else changes.
 */

/** R-7: uploads a free account may have. */
export const FREE_UPLOADS = 5;
/** R-7: uploads an account with a tick may have. */
export const TICK_UPLOADS = 25;

const GB = 1024 * 1024 * 1024;
/**
 * R-7: storage for a free account, 1 GB. A gigabyte is 1024^3 bytes here, as
 * this file has always counted it.
 */
export const FREE_STORAGE_BYTES = 1 * GB;
/** R-7: storage for an account with a tick, 10 GB. */
export const TICK_STORAGE_BYTES = 10 * GB;

/**
 * The four stored tick columns, for a Prisma `select`. Every read that feeds
 * an allowance selects exactly these and hands the row to `holdsTick`.
 */
export const TICK_COLUMNS = {
  creatorVerifiedAt: true,
  creatorVerifiedUntil: true,
  professionalVerifiedAt: true,
  professionalVerifiedUntil: true,
} as const;

/**
 * True when the account holds either tick now. Decided by the one function
 * that decides ticks everywhere, so an expired tick stops counting at the
 * same instant it stops being drawn.
 */
export function holdsTick(
  row: VerificationColumns | null | undefined,
  now: Date = new Date(),
): boolean {
  return holdsAnyTick(deriveVerificationState(row, now));
}

export interface UploadAllowance {
  /** How many pieces the account may have: FREE_UPLOADS or TICK_UPLOADS. */
  total: number;
}

/**
 * The publish cap. Counted on CreatorState.slotsUsed, which every create
 * claims against and every removal or rejection gives back.
 */
export function uploadAllowanceFor(tickHeld: boolean): UploadAllowance {
  return { total: tickHeld ? TICK_UPLOADS : FREE_UPLOADS };
}

/**
 * How much the account may STORE, in bytes. A second, independent limit:
 * the publish cap limits how many pieces exist, this limits how much space
 * every file the account uploads takes (content, avatars and documents
 * alike), counted on StorageObject rows by StorageService.usageFor.
 *
 * The same for an account with no CreatorState row: R-7 says "free
 * accounts", not "free creators", and an account that is not a creator can
 * still upload an avatar or a KYC document.
 */
export function storageAllowanceFor(tickHeld: boolean): number {
  return tickHeld ? TICK_STORAGE_BYTES : FREE_STORAGE_BYTES;
}
