/**
 * Finding a person to send money to (task WALLET-08, W7).
 *
 * The routes search everyone who has an open wallet, so what they answer and
 * how often they answer it are bounded here, in one place.
 */

/** Most people one search answers with (the declared maximum, CONVENTIONS.md section 6). */
export const RECIPIENT_SEARCH_MAX = 20;

/** Most people the recent list answers with (the declared maximum). */
export const RECENT_RECIPIENTS_MAX = 10;

/**
 * Fewest characters a name or @handle search takes, counted after trimming
 * (and after a leading "@"). One letter would list a quarter of the people
 * with a wallet. A phone is never searched by part, so this does not apply
 * to one: a phone is found in full or not at all.
 */
export const RECIPIENT_SEARCH_MIN_CHARS = 2;

/** The most the search text may be, spaces included (the DTO's MaxLength). */
export const RECIPIENT_SEARCH_MAX_CHARS = 60;

/**
 * PROVISIONAL(RECIPIENT-SEARCH-RATE, owner=YOU, why=no ruling names a limit for a search that reaches every wallet holder; the lead asked for a per-address limit tighter than the global one)
 *
 * The per-address limits on `GET /money/recipients`, on top of the app's
 * global ones (`short` 20 a second, `medium` 200 a minute), which stay: at
 * most 20 searches a minute and 120 an hour from one address. A person typing
 * a name sends a handful of requests, so this is generous for a person and
 * slow for anyone listing the wallet holders by prefix or trying phone
 * numbers one at a time. Carrier NAT puts many people behind one address,
 * hence 120 an hour, not fewer. Both are on the app's own named throttlers:
 * a name it does not register would be ignored. The per-address limit is
 * all the global guard can know: it runs before the token is checked, so it
 * cannot count per person (BACKEND_GAPS G-133).
 */
export const RECIPIENT_SEARCH_THROTTLE = {
  short: { limit: 20, ttl: 60_000 },
  medium: { limit: 120, ttl: 60 * 60_000 },
};
