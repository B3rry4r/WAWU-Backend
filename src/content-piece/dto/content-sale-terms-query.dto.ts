import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * GET /content/sale-terms query (FIX-110, R-21). The price is the one a
 * creator is typing: integer kobo inside the bounds `POST /content` takes
 * (0 to 10,000,000 naira); the service refuses a fraction of a naira.
 */
export class ContentSaleTermsQueryDto {
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  // Plain digits without leading zeros only: Number() also takes 0x1388, 0005000, " 5000" and +5000, which POST /content could never receive.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value)
      ? Number(value)
      : value,
  )
  @IsInt()
  @Min(0)
  @Max(10_000_000 * 100)
  priceKobo?: number;
}
