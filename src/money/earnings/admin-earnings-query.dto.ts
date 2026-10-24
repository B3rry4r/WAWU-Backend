import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** One sentence for every way `limit` can be wrong (a word used to read "must not be greater than 100"). */
const LIMIT_MESSAGE = 'limit must be a whole number from 1 to 100.';

/** GET /admin/money/earnings/before-start. */
export class AdminUnsweptQueryDto {
  /** Sales per page, 1 to 100 (50 when absent). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: LIMIT_MESSAGE })
  @Min(1, { message: LIMIT_MESSAGE })
  @Max(100, { message: LIMIT_MESSAGE })
  limit?: number;

  /** The `nextCursor` of the page before (CONVENTIONS section 6). */
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

/** GET /admin/money/earnings/in-review (OPS-26): a cursor page, 20 rows when `limit` is absent. */
export class AdminReviewQueryDto {
  /** Rows per page, 1 to 100 (20 when absent, CONVENTIONS section 6). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: LIMIT_MESSAGE })
  @Min(1, { message: LIMIT_MESSAGE })
  @Max(100, { message: LIMIT_MESSAGE })
  limit?: number;

  /** The `nextCursor` of the page before; opaque, sent back as given. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;
}
