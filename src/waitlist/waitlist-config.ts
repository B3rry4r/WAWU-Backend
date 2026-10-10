/**
 * The event registration link's settings (JOIN-01, R-48).
 *
 * The OFFER (its name, price, tier, days and dates) is in
 * `src/plans/plans.config.json` under `event_offers`, never here. What is
 * here is how the routes and sweeps behave.
 *
 * PROVISIONAL(WAITLIST-LIMITS, owner=YOU, why=no ruling names how often one address may call the public registration routes; the lead ruled these on 10 Oct 2026 because Nigerian mobile networks put many phones behind one address and a venue shares one Wi-Fi address)
 *
 * Each public route (`/waitlist/...`) is limited per address on the app's own
 * `medium` throttler, in a 10 minute window: the two reads (the offer and a
 * registration's status) `WAITLIST_THROTTLE_READ.medium.limit` calls, the
 * two writes (register and verify) `WAITLIST_THROTTLE_WRITE.medium.limit`.
 * The guard counts each route apart, so one venue address can register this
 * many people and poll this many payment checks in the window. The global
 * `short` limit (20 a second per route) still applies. Both figures are
 * above `medium`'s own 200 a minute count, so a burst inside one minute is
 * allowed further than elsewhere; the sustained rate (calls a second over the
 * window) is below it, and hub-rate-limits.contract.spec.ts holds exactly that.
 */
export const WAITLIST_THROTTLE_READ = {
  medium: { limit: 600, ttl: 10 * 60_000 },
};
export const WAITLIST_THROTTLE_WRITE = {
  medium: { limit: 300, ttl: 10 * 60_000 },
};

/**
 * PROVISIONAL(WAITLIST-RECHECK, owner=YOU, why=no ruling says how long a payer who never came back is waited for or when an unpaid registration is dropped)
 *
 * A `pending` registration is re-checked with Flutterwave by its reference
 * once it is `RECHECK_AFTER_MS` old (the payer has had time to finish) and
 * until it is `RECHECK_UNTIL_MS` old, `RECHECK_EVERY` is a cron expression,
 * and EVERY row in that window is looked at in each run, `RECHECK_PAGE` rows
 * read at a time (a page size, never a cap on the run). A `pending` row
 * older than `UNPAID_KEEP_MS` is deleted: no personal data is kept for
 * people who did not pay.
 */
export const RECHECK_AFTER_MS = 5 * 60_000;
export const RECHECK_UNTIL_MS = 48 * 60 * 60_000;
export const RECHECK_EVERY = '*/5 * * * *';
export const RECHECK_PAGE = 200;
export const UNPAID_KEEP_MS = 7 * 24 * 60 * 60_000;
export const UNPAID_PURGE_EVERY = '17 3 * * *';

/** Longest values the form takes (characters). */
export const NAME_MAX = 100;
export const NAME_MIN = 2;
export const SHORT_TEXT_MAX = 60;
export const EMAIL_MAX = 254;

/** The prefix of every reference (it is the Flutterwave tx_ref). */
export const REFERENCE_PREFIX = 'wawu-join-';
/** Random bytes in a reference: 18 bytes is 144 bits, above the 128 asked. */
export const REFERENCE_BYTES = 18;
