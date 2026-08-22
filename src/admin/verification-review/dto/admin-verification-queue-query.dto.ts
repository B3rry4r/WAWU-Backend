import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { VERIFICATION_TIER_VALUES, type VerificationTierValue } from '../../../verification-submission/dto/create-verification-submission.dto';

/**
 * GET /admin/verification/queue query.
 *
 * Offset pagination via the app's own PaginationQueryDto. Note this endpoint
 * does NOT reproduce `GET /verification/submissions`'s opt-in pagination
 * (hazard H-4: that route returns a bare array when neither page nor perPage
 * is supplied). A shape that changes with the query is a shipped quirk worth
 * protecting on the route that has it, and worth not repeating on a new one.
 *
 * The tier filter reuses the app's own value list rather than restating it, so
 * a new rung cannot exist on one surface and not the other.
 */
export class AdminVerificationQueueQueryDto extends PaginationQueryDto {
  /** Oldest first is the default — a queue that defaults to newest starves the longest wait. */
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort: 'oldest' | 'newest' = 'oldest';

  /** Work one rung at a time. Omitted means every pending submission. */
  @IsOptional()
  @IsIn(VERIFICATION_TIER_VALUES)
  tier?: VerificationTierValue;
}
