import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The cheapest tier on `GET /plans`, in the person's billing currency. */
export class HostTierLowestDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  /** Whole minor units of the reason's `currency` (kobo or cents). */
  @ApiProperty({ type: 'integer' })
  priceMinor!: number;
}

/**
 * What a refused host answers when the reason is the missing tier (EVENTS-12):
 * the contract's one error envelope (docs/contract/CONVENTIONS.md section 3)
 * with a 403 `reason`. The app shows "Needs a tier" and the lowest price from
 * it, and "See tiers" opens the plan.
 */
export class HostTierReasonDto {
  /**
   * `tier_required`, or `account_type_required` for an account that is
   * neither a creator nor a professional (it carries no tier fields).
   */
  @ApiProperty({ enum: ['tier_required', 'account_type_required'] })
  code!: 'tier_required' | 'account_type_required';

  /** A sentence the app may show as it is. No em-dash. */
  message!: string;

  /**
   * `none` (never had a tier) or `ended`. Only on `tier_required`.
   */
  @ApiPropertyOptional({ enum: ['none', 'ended'] })
  tierState?: 'none' | 'ended';

  /**
   * The currency of `lowestTier.priceMinor`. Absent only when the Hub could
   * not read the plan at that moment; the app then shows `message` alone.
   */
  @ApiPropertyOptional({ enum: ['NGN', 'USD'] })
  currency?: 'NGN' | 'USD';

  /** The lowest-priced tier in `currency`, for "From ...". */
  @ApiPropertyOptional({ nullable: true, type: () => HostTierLowestDto })
  lowestTier?: HostTierLowestDto | null;

  /** What to do, in order. Only on `account_type_required`. */
  @ApiPropertyOptional({ type: [String] })
  steps?: string[];

  /**
   * Kept from the verification refusal this answer replaces so no reader of
   * it breaks: always empty. Only on `account_type_required`.
   */
  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  purchasable?: object[];
}

/** The body of a 403 from a route that hosts an event or edits its tickets. */
export class HostTierErrorEnvelope {
  /** 403. */
  @ApiProperty({ type: 'integer', example: 403 })
  statusCode!: number;

  /** Same as reason.message. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;

  @ApiProperty({ type: () => HostTierReasonDto })
  reason!: HostTierReasonDto;
}
