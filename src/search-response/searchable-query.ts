import { BadRequestException } from '@nestjs/common';
import {
  isStorableText,
  unstorableTextMessage,
} from '../storable-text/storable-text';

/**
 * FIX-07. A search term Postgres cannot take.
 *
 * `q` reaches Postgres as a text parameter of an ILIKE. Postgres refuses a
 * NUL in text, so `GET /search?q=%00` used to throw inside Prisma and answer
 * 500 on the tabs that run a query (all, content, creators) and on
 * `/search/closest`. A lone UTF-16 surrogate is the other half of the same
 * rule: the driver would silently send U+FFFD in its place, so the search
 * would run for text the caller never wrote. Over HTTP the query parser
 * already turns a percent-encoded surrogate into U+FFFD, so in practice only
 * a NUL arrives; the surrogate check guards every other way in.
 *
 * The rule is `isCleanText`, the one GET /schools and the `schools` tab of
 * this route use (SCHOOLS-04), with one difference: a blank term is not
 * refused here. `q=%20` has always been a search (200), and `/search` is a
 * protected route, so every answer that was not a 500 stays as it was. For
 * any string that is not blank, `isCleanText` is false exactly when the
 * string holds a NUL or a lone surrogate (trimming never removes either).
 *
 * FIX-17 made this the rule for every query and path value on every route
 * (`isStorableText`), so over HTTP that check answers first, with the same
 * sentence; this one stays the guard for a direct call to the handlers.
 */
export function isSearchableQuery(q: string): boolean {
  return isStorableText(q);
}

/**
 * The refusal, word for word what the `schools` tab answers for the same
 * term, so every tab and `/search/closest` agree.
 */
export const UNSEARCHABLE_QUERY_MESSAGE = unstorableTextMessage('q');

/**
 * 400 naming `q`, thrown before any query runs. Called by the handlers after
 * the ValidationPipe, so a term that is also too long, missing, repeated or
 * paired with a bad `tab` keeps the 400 it already had.
 */
export function refuseUnsearchableQuery(q: string): void {
  if (!isSearchableQuery(q))
    throw new BadRequestException(UNSEARCHABLE_QUERY_MESSAGE);
}
