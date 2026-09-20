/**
 * What a creator account may publish and store.
 *
 * Both limits used to derive from `CreatorState.tier`. Subscriptions are gone
 * (build brief B1 — "There is no subscription tier"), so there is no tier to
 * derive from and both are now flat for every creator account.
 *
 * Renamed from `creator-tier-allowance.ts`: a module named after a concept
 * the codebase no longer has is a module that lies about itself.
 */

/**
 * The publish cap.
 *
 * Brief B2: "Maximum 5 items per account (products, content or services).
 * Hard cap, enforced server-side." One number, no ladder, and NOT a free/paid
 * split: the same brief removes free content entirely ("No free content.
 * Every listing carries a price"), so a free allowance would be an allowance
 * for something that can no longer be created.
 *
 * Counted across products, content AND services together — it is a cap on the
 * account, not on each kind, so five products means no room for a sixth item
 * of any type.
 */
export const MAX_ITEMS_PER_ACCOUNT = 5;

export interface UploadAllowance {
  /** Always MAX_ITEMS_PER_ACCOUNT. Kept as a field so call sites read the same as before. */
  total: number;
}

export function uploadAllowanceFor(): UploadAllowance {
  return { total: MAX_ITEMS_PER_ACCOUNT };
}

/**
 * How much a creator may STORE, in bytes.
 *
 * A SECOND, INDEPENDENT LIMIT. The publish cap limits how many pieces exist;
 * this limits how much space they take. They are not interchangeable: five
 * slots of 4K video is far more storage than five PDFs, and a platform that
 * only counted files would be billed for the difference.
 *
 * 2GB, which was already the floor for every tier below Pro Max. Pro Max's
 * 5GB went with the plan that sold it. Nobody loses storage they paid for,
 * because the live API reports zero successful payments ever.
 */
export const STORAGE_BYTES_PER_ACCOUNT = 2 * 1024 * 1024 * 1024;

/**
 * Unchanged in meaning: the quota for an account with no CreatorState row at
 * all, e.g. somebody who has never created anything but can still upload a
 * KYC document or an avatar. It now happens to equal the creator quota, but
 * they are still two separate facts and collapsing them would mean a later
 * change to one silently moved the other.
 */
export const DEFAULT_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

export function storageAllowanceFor(hasCreatorState: boolean): number {
  return hasCreatorState ? STORAGE_BYTES_PER_ACCOUNT : DEFAULT_STORAGE_BYTES;
}
