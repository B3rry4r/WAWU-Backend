import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  PLAN_PURCHASE_KINDS,
  PLAN_PURCHASE_METHODS,
  type PlanPurchaseKind,
  type PlanPurchaseMethod,
} from './plan-purchase-terms';

/** A tier id as the plans file writes it. */
const TIER_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The largest amount a body carries exactly (the money contract's bound): a
 * correctness limit, not a money rule.
 */
const MAX_EXACT_KOBO = Number.MAX_SAFE_INTEGER;

/** `?bump=true` and `?bump=false` read as the booleans they spell; anything else is a 400. */
const readFlag = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** GET /plans/purchases/quote?kind=&tierId=&bump= */
export class PlanPurchaseQuoteQueryDto {
  /** `tier` (a first purchase, or after the last ended), `renew` (the tier held) or `upgrade` (to a bigger tier). */
  @ApiProperty({ enum: PLAN_PURCHASE_KINDS })
  @IsIn(PLAN_PURCHASE_KINDS)
  kind!: PlanPurchaseKind;

  /** A tier in the plans file (`GET /plans`). */
  @ApiProperty({ pattern: TIER_ID_PATTERN.source })
  @Matches(TIER_ID_PATTERN, { message: 'tierId is not a valid tier id' })
  tierId!: string;

  /** Buy the checkout bump's extra points with it (VF6). */
  @Transform(readFlag)
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @IsBoolean()
  bump?: boolean;
}

/** POST /plans/purchases. Headers: Idempotency-Key, X-Transaction-Pin. */
export class PlanPurchaseDto {
  @ApiProperty({ enum: PLAN_PURCHASE_KINDS })
  @IsIn(PLAN_PURCHASE_KINDS)
  kind!: PlanPurchaseKind;

  @ApiProperty({ pattern: TIER_ID_PATTERN.source })
  @Matches(TIER_ID_PATTERN, { message: 'tierId is not a valid tier id' })
  tierId!: string;

  /** Buy the checkout bump's extra points with it. Default: no. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @IsBoolean()
  bump?: boolean;

  /** How it is paid: from the wallet. */
  @ApiProperty({ enum: PLAN_PURCHASE_METHODS })
  @IsIn(PLAN_PURCHASE_METHODS)
  method!: PlanPurchaseMethod;

  /** `payment.totalKobo` from the purchase quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  expectedTotalKobo!: number;

  /** `payment.quoteToken` from that quote: the server checks it is its own, for this person and this purchase, and not past its end. */
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}
