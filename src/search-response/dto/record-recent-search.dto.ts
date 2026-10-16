import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_SEARCH_QUERY_LENGTH } from './search-query.dto';

/** Body of POST /search/recent: the text the person searched. */
export class RecordRecentSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  q: string;
}
