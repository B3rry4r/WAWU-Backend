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

/**
 * What the person makes or does: the choices of the registration form's
 * "What do you make or do?" (the owner's list, 12 Oct 2026). The words are
 * stored exactly as written here, so the team reads the same words the person
 * chose. Optional on the route: a client that does not send one keeps working.
 */
export const WAITLIST_CRAFTS = [
  'Music',
  'Fashion',
  'Film and video',
  'Photography',
  'Art',
  'Design',
  'Food',
  'Digital art',
  'Tech and software',
  'Writing and media',
  'Professional services',
  'Founder or business',
  'Other',
] as const;

/**
 * The conference cities of "Which city will you attend?" (owner, 12 Oct 2026):
 * exactly four Nigerian cities and Online. Optional on the route.
 */
export const WAITLIST_CITIES = [
  'Lagos',
  'Abuja',
  'Port Harcourt',
  'Enugu',
  'Online',
] as const;

/** The prefix of every reference (it is the Flutterwave tx_ref). */
export const REFERENCE_PREFIX = 'wawu-join-';
/** Random bytes in a reference: 18 bytes is 144 bits, above the 128 asked. */
export const REFERENCE_BYTES = 18;

/**
 * How many references a start may draw before it gives up. The access code
 * (the first 8 hex characters after the prefix) is unique across all
 * registrations, so a draw that lands on a taken code is refused by the
 * database and a new reference is drawn. Each draw collides with probability
 * (registrations / 2^32), so five misses in a row cannot happen in practice.
 */
export const REFERENCE_ATTEMPTS = 5;
/** Characters of the access code (hex digits after REFERENCE_PREFIX), shown as two groups of four. */
export const ACCESS_CODE_LENGTH = 8;

/**
 * Referral codes on the registration page (REF-01, owner, 14 Oct 2026).
 *
 * A code is 3 to 20 letters and digits, stored in upper case and matched in
 * any case. A registration started with a code holds a place under the code's
 * limit for `REFERRAL_HOLD_MS` while it is unpaid; a place that is paid later
 * is always honoured, even after the hold ended.
 */
export const REFERRAL_CODE_MIN = 3;
export const REFERRAL_CODE_MAX = 20;
export const REFERRAL_COMMUNITY_MAX = 80;
export const REFERRAL_HOLD_MS = 30 * 60_000;
/** The words a code we do not have is refused with, on the check and on register. */
export const REFERRAL_UNKNOWN_WORDS =
  'We do not recognise that referral code. Check it, or leave it empty to pay the standard price.';

/**
 * PROVISIONAL(REFERRAL-PROBE-LIMITS, owner=YOU, why=no ruling says how many wrong referral codes one address may try before it is slowed; the lead chose a figure that a venue sharing one Wi-Fi address will not reach by mistyping, and 14 Oct's low finding D4 asked for the slowing)
 *
 * Code probing (SWEEP-JOIN D4). Every code that is not one of ours, on the
 * page's check and on a registration, is counted against the caller's
 * address. An address that has tried `REFERRAL_MISS_LIMIT` unknown codes in
 * the last `REFERRAL_MISS_WINDOW_MS` is asked to wait: its code checks and
 * registrations that carry a code are refused with a plain sentence until
 * the oldest of those tries is that old. A registration with no code is never
 * refused by this, and a person who types the right code never counts. The
 * figures only bite on someone trying codes one after another; they sit below
 * the per-route throttle (WAITLIST_THROTTLE_READ) on purpose.
 */
export const REFERRAL_MISS_LIMIT = 30;
export const REFERRAL_MISS_WINDOW_MS = 10 * 60_000;
/** The words an address that tried too many unknown codes is refused with. */
export const REFERRAL_PROBING_WORDS =
  'Too many codes were tried from this connection. Please wait a few minutes and try again, or leave the code empty to pay the standard price.';
