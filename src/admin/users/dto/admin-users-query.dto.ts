import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * GET /admin/users. `page` and `perPage` as on every admin list (offset). The
 * global ValidationPipe forbids unknown fields, so everything accepted is here.
 */
export class AdminUsersQueryDto extends PaginationQueryDto {
  /**
   * At least 2 characters. Matches a part of a handle (Hub), or, through WAWU
   * ID, a part of a name, a whole email or a whole phone in any usual form
   * (`08031234567`, `+234 803 123 4567`). Never logged.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  q?: string;
}
