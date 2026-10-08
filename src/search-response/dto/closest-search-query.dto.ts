import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_SEARCH_QUERY_LENGTH } from './search-query.dto';

/** Query for GET /search/closest — same `q` requirement as GET /search. */
export class ClosestSearchQueryDto {
  // FIX-17: the same 100-character cap as GET /search, for the same reason:
  // each word of `q` adds ILIKE scans, so an 8,000-word `q` cost 2.6 s.
  // Written first so it is checked last: a missing, empty or repeated `q`
  // keeps the 400 it answered before ("q should not be empty", "q must be a
  // string").
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  @IsString()
  @IsNotEmpty()
  q: string;
}
