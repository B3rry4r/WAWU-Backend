import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { EventStatus } from '../../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * GET /admin/events/queue query.
 *
 * Offset pagination inherited from the app's own PaginationQueryDto rather
 * than a second admin convention (conventions.md § Pagination). The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so an undeclared field is a
 * 400 rather than a silently ignored filter.
 */
export class AdminEventQueueQueryDto extends PaginationQueryDto {
  /**
   * Oldest first is the default and the point — a queue that defaults to
   * newest-first starves whoever has waited longest.
   */
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort: 'oldest' | 'newest' = 'oldest';
}

/**
 * GET /admin/events query — the all-statuses browse.
 *
 * This exists because a pending-only queue is not enough to run the feature:
 * feature, unfeature and takedown all act on PUBLISHED events, which by
 * definition are not in the queue. Without a browse an admin would have those
 * three controls and no way to reach anything to use them on — the same class
 * of dead end as a `pending` row with no approver.
 */
export class AdminEventListQueryDto extends PaginationQueryDto {
  /** Omitted means every status, including `removed`. */
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  /** Ordered by `startsAt`, so an admin browse reads like the calendar it moderates. */
  @IsOptional()
  @IsIn(['soonest', 'latest'])
  sort: 'soonest' | 'latest' = 'soonest';
}
