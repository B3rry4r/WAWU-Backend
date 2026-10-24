import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const LIMIT_MESSAGE = 'limit must be a whole number from 1 to 100.';

/** GET /admin/wallet-openings/stuck and GET /admin/identity-holds (OPS-26). */
export class AdminOpeningListQueryDto {
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
