import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const MY_CONTENT_FILTERS = ['live', 'pending', 'rejected'] as const;
export type MyContentFilter = (typeof MY_CONTENT_FILTERS)[number];

/** FIX-111: the only kind the list can be narrowed to, for the creator's own courses (the create flow's "From a course" picker). */
export const MY_CONTENT_TYPES = ['course'] as const;
export type MyContentType = (typeof MY_CONTENT_TYPES)[number];

/**
 * Query for GET /content/mine/library. No `status` means every piece the
 * creator still has (live, pending and rejected; a removed piece is gone).
 */
export class MyContentQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(MY_CONTENT_FILTERS)
  status?: MyContentFilter;

  /** Only the creator's own courses. Left out, every kind. */
  @IsOptional()
  @IsIn(MY_CONTENT_TYPES)
  contentType?: MyContentType;
}
