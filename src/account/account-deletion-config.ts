/**
 * How long a deletion waits (R-17, task SETTINGS-06): 30 days from the
 * request. Signing in during them cancels it (WAWU ID, SETTINGS-08); after
 * them the purge sweep deletes the account's data.
 */
export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * How long a `freezing` row may sit before the hourly sweep treats its
 * request as dead (SETTINGS-06, round 3). A request holds the row only for
 * the length of its provider calls (seconds); past this the wallet is let go
 * and the row removed, so a wallet is never frozen for good by a request
 * nobody retried.
 */
export const FREEZING_STALE_MINUTES = 10;
export const FREEZING_STALE_MS = FREEZING_STALE_MINUTES * 60 * 1000;

/**
 * The hourly pass (SETTINGS-06 round 7, verifier R6-2). It must never run
 * longer than the hour it is scheduled for, never ask the provider about the
 * same wallet from two servers at once, and never spend a client timeout on
 * every row while the provider is down.
 */
/** After this long a pass asks no more rows; the rest wait for the next pass. */
export const PASS_BUDGET_MS = 30 * 60 * 1000;
/** Provider failures in a row (a timeout, a refusal) that end a pass: the provider is down. */
export const PASS_OUTAGE_FAILURES = 3;
/** Rows a pass claims at a time. */
export const PASS_BATCH = 50;
/** How long a claim holds a row; a server that crashed mid-pass lets go of its rows when this runs out. */
export const PASS_CLAIM_LEASE_MS = 40 * 60 * 1000;

/**
 * Telling WAWU ID the deletion has started (SETTINGS-08, G-SETTINGS-08-1).
 * Until WAWU ID confirms its mark-deletion, the Hub does not purge: a sign-in
 * in WAWU ID could not cancel what WAWU ID does not know is pending. A call
 * that fails is asked again by the hourly pass, after a wait that doubles with
 * each failure.
 */
/** How long one mark-deletion call may take before it counts as failed. */
export const IDENTITY_MARK_TIMEOUT_MS = 10 * 1000;
/** The wait after the first failure; it doubles with each failure up to the cap. */
export const IDENTITY_RETRY_BASE_MS = 5 * 60 * 1000;
export const IDENTITY_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** How long a pass holds a row it is about to ask about (a second server leaves it alone). */
export const IDENTITY_CLAIM_LEASE_MS = 3 * 60 * 1000;
/** Rows a pass asks WAWU ID about at most. */
export const IDENTITY_RETRY_BATCH = 50;

/** The wait before the next try, once `failures` calls in a row have failed (1 or more). */
export function identityRetryDelayMs(failures: number): number {
  const doublings = Math.max(0, Math.min(failures, 30) - 1);
  return Math.min(
    IDENTITY_RETRY_MAX_MS,
    IDENTITY_RETRY_BASE_MS * 2 ** doublings,
  );
}
