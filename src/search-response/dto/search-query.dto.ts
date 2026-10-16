import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Narrows GET /search's aggregate response per registry.json "SearchResponse". */
export type SearchTab =
  'all' | 'content' | 'creators' | 'communities' | 'schools';

const SEARCH_TABS: SearchTab[] = [
  'all',
  'content',
  'creators',
  'communities',
  'schools',
];

/**
 * Upper bound on the search term. `q` feeds an unindexed ILIKE '%...%' scan
 * across several tables, so an unbounded string is a cheap way for a caller
 * to make the database do arbitrary work. 100 characters is well past any
 * real query a user types into the header search box.
 */
export const MAX_SEARCH_QUERY_LENGTH = 100;

/** Query for GET /search. `q` is required — an empty/missing search string is a 400, not an empty-results 200. */
export class SearchQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  q: string;

  @IsOptional()
  @IsIn(SEARCH_TABS)
  tab?: SearchTab;
}
