import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** A tip is a whole number of naira, as the web's is: from ₦1 to ₦10,000,000, in kobo. */
export const MIN_TIP_KOBO = 100;
export const MAX_TIP_KOBO = 1_000_000_000;

const digits = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^[0-9]{1,16}$/.test(value)
    ? Number(value)
    : value;

/** GET /tips/wallet/quote?creatorWawuId=&amountKobo= */
export class TipWalletQuoteQueryDto {
  /** The creator being tipped. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  creatorWawuId!: string;

  /** The tip in kobo, chosen by the payer: a whole number of naira (100 to 1,000,000,000). */
  @ApiProperty({ type: 'integer', minimum: MIN_TIP_KOBO })
  @Transform(digits)
  @IsInt({ message: 'amountKobo must be a whole number of kobo' })
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;
}

/** POST /tips/wallet. Headers: Idempotency-Key, X-Transaction-Pin. */
export class TipWalletDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  creatorWawuId!: string;

  @ApiProperty({ type: 'integer', minimum: MIN_TIP_KOBO })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  /** The message that goes with the tip, 500 characters at most. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** `payment.totalKobo` from the quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedTotalKobo!: number;

  /** `payment.quoteToken` from that quote. */
  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}
