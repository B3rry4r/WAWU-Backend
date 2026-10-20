/**
 * How long a deleted account's ID documents are kept (SETTINGS-09, R-73, owner
 * Q-45 answer of 19 Oct 2026): hidden from everyone for 5 years after the
 * deletion completed, then deleted.
 *
 * What the documents are, and where they sit, is decided by the purge
 * (`FILE_KINDS` in purge-files.ts, decision OWNER): the ID card photo
 * (`kyc/id-document`), the documents of a service application
 * (`service-application/document`) and of a professional listing
 * (`professional/document`), and any file a verification, KYC, application or
 * professional row named. The purge refiles their `StorageObject` rows under
 * `deleted-account` and leaves the objects in the bucket. Nothing reads those
 * rows: the rows that named the files are deleted by the purge, and no route
 * lists `deleted-account` files. WAWU ID holds no document.
 */

/** The admin setting (registry key) that holds the days kept. */
export const ID_DOCS_KEEP_DAYS_SETTING = 'id_docs_keep_days';

/** The launch value in the seed: 5 years (5 x 365 + 1 leap day). */
export const ID_DOCS_KEEP_DAYS_LAUNCH = 1826;

/** The daily sweep: 03:41 server time, named so a spec can find it. */
export const ID_DOCS_RETENTION_CRON = '41 3 * * *';
export const ID_DOCS_RETENTION_NAME = 'id-docs-retention';

/**
 * How long a server holds one account (a column value, never a database lock).
 * A server that dies mid-account frees it when this passes; the next day's run
 * takes the rest.
 */
export const ID_DOCS_CLAIM_MS = 15 * 60_000;

/** Accounts looked at per query, and the most one run works before it stops. */
export const ID_DOCS_ACCOUNT_PAGE = 100;
export const ID_DOCS_RUN_BUDGET_MS = 10 * 60_000;

/** Objects removed per call to the bucket. */
export const ID_DOCS_FILE_PAGE = 200;
