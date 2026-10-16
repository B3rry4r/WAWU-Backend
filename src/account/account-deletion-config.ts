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
