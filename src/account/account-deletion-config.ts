/**
 * How long a deletion waits (R-17, task SETTINGS-06): 30 days from the
 * request. Signing in during them cancels it (WAWU ID, SETTINGS-08); after
 * them the purge sweep deletes the account's data.
 */
export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
