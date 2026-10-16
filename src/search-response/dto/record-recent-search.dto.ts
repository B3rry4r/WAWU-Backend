import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_SEARCH_QUERY_LENGTH } from './search-query.dto';

/**
 * Body of POST /search/recent: the text the person searched.
 *
 * The decorators sit in this order on purpose: the answer names the FIRST
 * failed rule, and class-validator runs the one written last first. So a
 * missing or null `q` says it is required, a number or an array says it must
 * be text, and only a text says it is empty or too long.
 */
export class RecordRecentSearchDto {
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  @IsNotEmpty()
  @IsString({ message: 'q must be text' })
  @IsDefined({ message: 'q is required' })
  q: string;
}
