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
