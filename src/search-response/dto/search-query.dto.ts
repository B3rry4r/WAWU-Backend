import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Narrows GET /search's aggregate response per registry.json "SearchResponse". */
export type SearchTab = 'all' | 'content' | 'creators' | 'communities';

const SEARCH_TABS: SearchTab[] = ['all', 'content', 'creators', 'communities'];

/** Query for GET /search. `q` is required — an empty/missing search string is a 400, not an empty-results 200. */
export class SearchQueryDto {
  @IsString()
  @IsNotEmpty()
  q: string;

  @IsOptional()
  @IsIn(SEARCH_TABS)
  tab?: SearchTab;
}
