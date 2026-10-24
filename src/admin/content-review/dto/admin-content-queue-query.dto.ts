import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * GET /admin/content/queue query.
 *
 * Offset pagination, inherited from the app's own PaginationQueryDto rather
 * than a second admin convention (conventions.md § Pagination). The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so every accepted field
 * has to be declared here or the request is a 400.
 *
 * There is exactly one filter, and it is narrow on purpose: this endpoint is
 * the review QUEUE. The broader "every piece, any status" browse is a
 * separate screen in .pipeline/derived-surface.json (C2) and is not built
 * here.
 */
export class AdminContentQueueQueryDto extends PaginationQueryDto {
  /**
   * Oldest first is the default and the point — a queue that defaults to
   * newest-first starves the creator who has waited longest. `newest` exists
   * for the reviewer checking what just arrived.
   */
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort: 'oldest' | 'newest' = 'oldest';

  /**
   * Only pieces whose creator lives in this country, ISO 3166-1 alpha-2
   * ("NG", any case) from GET /geo/countries (GEO-02, R-85). An unknown code
   * is a 400.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  countryCode?: string;

  /** Only pieces whose creator lives in this region, the full ISO 3166-2 code ("NG-LA"). Alone it also narrows the country. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  regionCode?: string;
}
