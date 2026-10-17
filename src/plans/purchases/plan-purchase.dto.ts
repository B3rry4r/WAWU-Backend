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
  ValidateIf,
} from 'class-validator';
import {
  PLAN_PURCHASE_METHODS,
  PLAN_PURCHASE_REQUEST_KINDS,
  POINTS_PACK_KIND,
  type PlanPurchaseMethod,
  type PlanPurchaseRequestKind,
} from './plan-purchase-terms';

/** A tier id as the plans file writes it. */
const TIER_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** A points pack id as the plans file writes it (same shape as a tier id). */
const PACK_ID_PATTERN = TIER_ID_PATTERN;

/** A tier purchase carries a `tierId`; a points pack purchase carries a `packId` instead. */
const isTier = (o: { kind?: unknown }): boolean => o.kind !== POINTS_PACK_KIND;
const isPack = (o: { kind?: unknown }): boolean => o.kind === POINTS_PACK_KIND;

/**
 * The largest amount a body carries exactly (the money contract's bound): a
 * correctness limit, not a money rule.
 */
const MAX_EXACT_KOBO = Number.MAX_SAFE_INTEGER;

/** `?bump=true` and `?bump=false` read as the booleans they spell; anything else is a 400. */
const readFlag = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** GET /plans/purchases/quote?kind=&tierId=&bump= (or ?kind=points_pack&packId=) */
export class PlanPurchaseQuoteQueryDto {
  /**
   * `tier` (a first purchase, or after the last ended), `renew` (the tier
   * held), `upgrade` (to a bigger tier) or `points_pack` (a points pack,
   * POINTS-02).
   */
  @ApiProperty({ enum: PLAN_PURCHASE_REQUEST_KINDS })
  @IsIn(PLAN_PURCHASE_REQUEST_KINDS)
  kind!: PlanPurchaseRequestKind;

  /** A tier in the plans file (`GET /plans`). Required for a tier purchase; not sent for a points pack. */
  @ApiPropertyOptional({ pattern: TIER_ID_PATTERN.source })
  @ValidateIf(isTier)
  @Matches(TIER_ID_PATTERN, { message: 'tierId is not a valid tier id' })
  tierId?: string;

  /** A pack in the plans file (`GET /plans` `packs`). Required for `points_pack`; not sent for a tier purchase. */
  @ApiPropertyOptional({ pattern: PACK_ID_PATTERN.source })
  @ValidateIf(isPack)
  @Matches(PACK_ID_PATTERN, { message: 'packId is not a valid pack id' })
  packId?: string;

  /** Buy the checkout bump's extra points with it (VF6). Not for a points pack. */
  @Transform(readFlag)
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @IsBoolean()
  bump?: boolean;
}

/** POST /plans/purchases. Headers: Idempotency-Key, X-Transaction-Pin. */
export class PlanPurchaseDto {
  @ApiProperty({ enum: PLAN_PURCHASE_REQUEST_KINDS })
  @IsIn(PLAN_PURCHASE_REQUEST_KINDS)
  kind!: PlanPurchaseRequestKind;

  /** Required for a tier purchase; not sent for a points pack. */
  @ApiPropertyOptional({ pattern: TIER_ID_PATTERN.source })
  @ValidateIf(isTier)
  @Matches(TIER_ID_PATTERN, { message: 'tierId is not a valid tier id' })
  tierId?: string;

  /** Required for `points_pack`; not sent for a tier purchase. */
  @ApiPropertyOptional({ pattern: PACK_ID_PATTERN.source })
  @ValidateIf(isPack)
  @Matches(PACK_ID_PATTERN, { message: 'packId is not a valid pack id' })
  packId?: string;

  /** Buy the checkout bump's extra points with it. Default: no. Not for a points pack. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @IsBoolean()
  bump?: boolean;

  /**
   * How it is paid: `wallet` from the balance now, or `transfer`: the answer
   * carries the wallet's own account number and the amount still needed, and
   * the purchase is paid from the wallet when the money lands.
   */
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
