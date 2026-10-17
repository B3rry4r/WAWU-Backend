import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

/** POST /content/:id/unlock/wallet. Headers: Idempotency-Key, X-Transaction-Pin. */
export class UnlockWalletDto {
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
