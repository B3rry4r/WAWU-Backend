import { Injectable } from '@nestjs/common';
import { MoneyError } from '../money-error';
import { PersonWindowLimiter } from '../person-window-limiter';

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
 * PROVISIONAL(RECIPIENT-SEARCH-RATE, owner=YOU, why=no ruling names a limit for a search that reaches every wallet holder; the lead set these figures after the round-1 verifier walked 6,000 holders at about 3 requests a person)
 *
 * The limits on `GET /money/recipients`. Default (agent/lead), owner may
 * override. Two kinds, both kept:
 *
 * - **Per address** (`RECIPIENT_SEARCH_THROTTLE`), on top of the app's
 *   global ones (`short` 20 a second, `medium` 200 a minute), which stay: at
 *   most 20 searches a minute and 120 an hour from one address. Both are on
 *   the app's own named throttlers: a name it does not register would be
 *   ignored. This is all the global guard can know: it runs before the token
 *   is verified.
 * - **Per person** (`RECIPIENT_SEARCH_PERSON_LIMITS`, `RecipientSearchLimiter`),
 *   counted in the handler after the token is verified and the wallet gate
 *   has found the wallet, keyed by the verified wawuUserId: at most 20 a
 *   minute, 120 an hour and 500 a day, each a fixed window that starts at the
 *   person's first search in it. Beyond any is `429
 *   recipient_search_rate_limited` with `retryAfterSeconds` (rounded up) and a
 *   `Retry-After` header. One account cannot get round this by changing
 *   address (a whole IPv6 /64 is one caller's), and two accounts on one
 *   address each keep their own budget while the address limit still holds.
 *
 * A person typing a name sends a handful of requests, so these are generous
 * for a person and slow for anyone walking the wallet holders by prefix or
 * trying phone numbers one at a time. Carrier NAT puts many people behind one
 * address, hence 120 an hour there, not fewer.
 */
export const RECIPIENT_SEARCH_THROTTLE = {
  short: { limit: 20, ttl: 60_000 },
  medium: { limit: 120, ttl: 60 * 60_000 },
};

export const RECIPIENT_SEARCH_PERSON_LIMITS = [
  { name: 'minute', limit: 20, windowMs: 60_000 },
  { name: 'hour', limit: 120, windowMs: 60 * 60_000 },
  { name: 'day', limit: 500, windowMs: 24 * 60 * 60_000 },
] as const;

export const RECIPIENT_SEARCH_RATE_LIMITED_MESSAGE =
  'You have searched a lot in a short time. Try again in a little while.';

/**
 * The per-person search limit: the shared fixed-window counter
 * (`PersonWindowLimiter`) with RECIPIENT_SEARCH_PERSON_LIMITS. An entry is
 * made only by `take`, which the controller calls after WawuAuthGuard and
 * the wallet gate, so a forged or missing token never makes one. A search
 * the route itself refuses with a 400 is read before it is counted and does
 * not count.
 */
@Injectable()
export class RecipientSearchLimiter extends PersonWindowLimiter {
  constructor() {
    super(
      RECIPIENT_SEARCH_PERSON_LIMITS,
      (retryAfterSeconds) =>
        new MoneyError(
          'recipient_search_rate_limited',
          RECIPIENT_SEARCH_RATE_LIMITED_MESSAGE,
          { retryAfterSeconds },
        ),
    );
  }
}
