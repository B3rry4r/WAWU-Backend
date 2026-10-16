import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Every ME-10 list is a cursor page (docs/contract/CONVENTIONS.md section 6). */
export class MeCursorQueryDto {
  /** `nextCursor` from the previous page. Opaque: send it back as given. Absent for the first page. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /** Rows per page, 1 to 100. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/** GET /me/saved (M30's tabs). */
export class SavedQueryDto extends MeCursorQueryDto {
  /** M30's tab: everything, or one kind. Default `all`. */
  @IsOptional()
  @IsIn(['all', 'content', 'events', 'creators'])
  type?: 'all' | 'content' | 'events' | 'creators' = 'all';
}

/** GET /me/purchases (M29). */
export class PurchasesQueryDto extends MeCursorQueryDto {
  /**
   * "Search what you've bought": trimmed, then 2 to 60 characters. Matches
   * part of a piece's title or its creator's handle, ignoring case.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(2, 60)
  q?: string;
}

/** GET /me/notifications (M31's filter chips). */
export class NotificationFeedQueryDto extends MeCursorQueryDto {
  /** M31's chip. Default `all`. */
  @IsOptional()
  @IsIn(['all', 'money', 'messages', 'content'])
  category?: 'all' | 'money' | 'messages' | 'content' = 'all';
}

/** A month, `YYYY-MM` in Africa/Lagos time (CONVENTIONS section 7). */
const MONTH_PATTERN = /^(20\d\d)-(0[1-9]|1[0-2])$/;

/** GET /me/earnings. */
export class EarningsQueryDto {
  /** YYYY-MM in Africa/Lagos time, 2000-01 to 2099-12. Default: this month. */
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month must be YYYY-MM.' })
  month?: string;
}

/** GET /me/earnings/sales. */
export class EarningSalesQueryDto extends MeCursorQueryDto {
  /** YYYY-MM in Africa/Lagos time, 2000-01 to 2099-12. Default: this month. */
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month must be YYYY-MM.' })
  month?: string;
}
