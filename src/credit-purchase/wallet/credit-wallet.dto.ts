import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { CreditPack } from '../../../generated/prisma/enums';

/**
 * The largest amount a body carries exactly (the money contract's bound): a
 * correctness limit, not a money rule.
 */
const MAX_EXACT_KOBO = Number.MAX_SAFE_INTEGER;

/** GET /credits/purchase/wallet/quote?pack= */
export class CreditWalletQuoteQueryDto {
  /** One of the packs `GET /credits/packs` lists. */
  @ApiProperty({ enum: CreditPack })
  @IsEnum(CreditPack, { message: 'pack must be one of: starter, popular, pro' })
  pack!: CreditPack;
}

/** POST /credits/purchase/wallet. Headers: Idempotency-Key, X-Transaction-Pin. */
export class CreditWalletPurchaseDto {
  @ApiProperty({ enum: CreditPack })
  @IsEnum(CreditPack, { message: 'pack must be one of: starter, popular, pro' })
  pack!: CreditPack;

  /** `payment.totalKobo` from the quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  expectedTotalKobo!: number;

  /** `payment.quoteToken` from that quote: the server checks it is its own, for this person and this pack, and not past its end. */
  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}
