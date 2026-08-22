import { IsIn, IsOptional } from 'class-validator';
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
}
