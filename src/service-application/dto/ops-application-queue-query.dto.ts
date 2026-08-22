import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ServiceApplicationKind } from '../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** The enum's own members, so a new kind cannot be forgotten here. */
const APPLICATION_KINDS = Object.values(ServiceApplicationKind);

/**
 * GET /services/ops/applications query.
 *
 * Offset pagination, inherited from the APP'S OWN `PaginationQueryDto` rather
 * than a second admin convention — so the response reports a real `total`
 * from a `count()`, not the length of the page it just returned. The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so every accepted field has
 * to be declared here or the request is a 400.
 */
export class OpsApplicationQueueQueryDto extends PaginationQueryDto {
  /**
   * Oldest first is the default and the point: someone has paid ₦25,000 for a
   * CAC registration and is waiting on it, and a queue that defaults to
   * newest-first starves whoever has waited longest. `newest` exists for the
   * operator checking what just came in.
   */
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort: 'oldest' | 'newest' = 'oldest';

  /**
   * Free-form, NOT an enum, and deliberately so: `ServiceApplication.status`
   * is a plain String column and `ProgressApplicationDto.status` lets an
   * operator write any 40-character value into it. Constraining the filter to
   * a fixed list would make an operator's own status un-filterable the moment
   * they used one — the queue would show them a row they could not find again.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  /** Which service. Closed set, because `kind` genuinely is a Postgres enum. */
  @IsOptional()
  @IsIn(APPLICATION_KINDS)
  kind?: ServiceApplicationKind;
}
