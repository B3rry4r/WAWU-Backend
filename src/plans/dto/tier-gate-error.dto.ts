import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * What a refused publish or upload answers (TIER-02): the contract's one error
 * envelope (docs/contract/CONVENTIONS.md section 3) with the 402 `reason`
 * that says what the person has, what they have used, and what they can buy
 * to carry on. The offers are the same figures `GET /plans` answers, in the
 * person's billing currency only.
 */
export class TierGateReasonDto {
  @ApiProperty({ enum: ['tier_required', 'product_limit_reached'] })
  code!: 'tier_required' | 'product_limit_reached';

  /** A sentence the app may show as it is. No em-dash. */
  message!: string;

  /**
   * The person's tier: `none` (never had one), `active`, `ending` or `ended`.
   * `tier_required` answers `none` or `ended`.
   */
  @ApiProperty({ enum: ['none', 'active', 'ending', 'ended'] })
  tierState!: 'none' | 'active' | 'ending' | 'ended';

  /** Products published now. */
  @ApiProperty({ type: 'integer' })
  productsUsed!: number;

  /** Products they may have published at once (0 when nothing allows publishing). */
  @ApiProperty({ type: 'integer' })
  productsAllowed!: number;

  /**
   * The currency of every amount in `tiers` and `extraProducts`. The offers
   * (`currency`, `tiers`, `extraProducts`) are always there; they are absent
   * only when the Hub could not read the plan at that moment, and the app
   * then shows `message` alone.
   */
  @ApiPropertyOptional({ enum: ['NGN', 'USD'] })
  currency?: 'NGN' | 'USD';

  /**
   * `tier_required`: every tier. `product_limit_reached`: the tiers that
   * would let the person publish another, that is, allow more products than
   * they have published now (none when no tier does, including when they have
   * more published than any tier allows).
   */
  @ApiPropertyOptional({
    type: 'array',
    items: { $ref: getSchemaPath('PlanTierView') },
  })
  tiers?: unknown[];

  /**
   * The extra products they can buy now, or null when they cannot: no running
   * tier, or buying them would still leave fewer places than products
   * published.
   */
  @ApiPropertyOptional({
    nullable: true,
    allOf: [{ $ref: getSchemaPath('PlanExtraProductsView') }],
  })
  extraProducts?: unknown;
}

/** The body of a 402 from a route that publishes or accepts a file. */
export class TierGateErrorEnvelope {
  /** 402. */
  @ApiProperty({ type: 'integer', example: 402 })
  statusCode!: number;

  /** Same as reason.message. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;

  @ApiProperty({ type: () => TierGateReasonDto })
  reason!: TierGateReasonDto;
}
