import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** GET /admin/money/earnings/before-start. */
export class AdminUnsweptQueryDto {
  /** Sales per page, 1 to 100 (50 when absent). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** The `nextAfter` of the page before. */
  @IsOptional()
  @IsUUID()
  after?: string;
}
