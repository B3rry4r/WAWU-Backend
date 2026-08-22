import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * GET /admin/kyc/queue query.
 *
 * Offset pagination, inherited from the app's own PaginationQueryDto rather
 * than a second admin convention. The global ValidationPipe runs with
 * `forbidNonWhitelisted`, so every accepted field has to be declared here or
 * the request is a 400.
 *
 * There is exactly one filter and it is narrow on purpose: this endpoint is
 * the review QUEUE, and only `pending` is in it. A queue that also listed
 * approved and rejected submissions would make "how far behind are we"
 * unanswerable, which is the one question it exists to answer — and every
 * extra row it returned would be another creator's bank details on a screen
 * nobody needed to open.
 */
export class AdminKycQueueQueryDto extends PaginationQueryDto {
  /**
   * Oldest first is the default and the point. A creator cannot be paid until
   * a human clears them, so a queue that defaults to newest-first starves the
   * one who has waited longest. `newest` exists for the reviewer checking what
   * just arrived.
   */
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort: 'oldest' | 'newest' = 'oldest';
}
