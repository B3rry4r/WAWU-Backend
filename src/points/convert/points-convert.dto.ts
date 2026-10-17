import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { POINTS_LIMITS } from '../points-config';

const POINTS_MESSAGE = 'points must be a whole number of 1 or more.';

/** The longest quote token the convert request accepts (a signed token is far shorter). */
export const QUOTE_TOKEN_MAX_LENGTH = 1024;
export const QUOTE_TOKEN_MESSAGE =
  'quoteToken must be the quoteToken of the points quote you were shown.';

/** `POST /points/convert`: how many points to turn into cash, and the quote they were shown. The PIN is in `X-Transaction-Pin`, never here. */
export class PointsConvertDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: POINTS_LIMITS.maxPoints,
  })
  @IsInt({ message: POINTS_MESSAGE })
  @Min(1, { message: POINTS_MESSAGE })
  @Max(POINTS_LIMITS.maxPoints, { message: POINTS_MESSAGE })
  points!: number;

  /** `quoteToken` from the points quote the person saw. A conversion is paid at that quote or not at all (`409 quote_changed`). */
  @ApiProperty({ minLength: 1, maxLength: QUOTE_TOKEN_MAX_LENGTH })
  @IsString({ message: QUOTE_TOKEN_MESSAGE })
  @Length(1, QUOTE_TOKEN_MAX_LENGTH, { message: QUOTE_TOKEN_MESSAGE })
  quoteToken!: string;
}

/** `GET /points/convert/quote?points=`. */
export class PointsConvertQuoteQueryDto {
  /**
   * The points to quote. Left out, the quote is for the whole balance.
   * Digits only: `1e3` or `1,000` is a 400, never read as some other number.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{1,10}$/.test(value)
      ? Number(value)
      : value,
  )
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: POINTS_LIMITS.maxPoints,
  })
  @IsOptional()
  @IsInt({ message: POINTS_MESSAGE })
  @Min(1, { message: POINTS_MESSAGE })
  @Max(POINTS_LIMITS.maxPoints, { message: POINTS_MESSAGE })
  points?: number;
}
