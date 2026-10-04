import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const MY_CONTENT_FILTERS = ['live', 'pending', 'rejected'] as const;
export type MyContentFilter = (typeof MY_CONTENT_FILTERS)[number];

/**
 * Query for GET /content/mine/library. No `status` means every piece the
 * creator still has (live, pending and rejected; a removed piece is gone).
 */
export class MyContentQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(MY_CONTENT_FILTERS)
  status?: MyContentFilter;
}
