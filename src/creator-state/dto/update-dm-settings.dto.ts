import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * PATCH /creator/dm-settings body.
 *
 * `dmPrice` was capped at ₦500 per docs/02_TECHNICAL_CONTEXT.md §2 and
 * docs/01_SPEC.md line 23. That ceiling is removed on the product owner's
 * instruction: creators set their own rate. Both docs need updating to match.
 *
 * A floor of ₦50 stays — it stops a ₦0/₦1 price making paid messaging
 * meaningless — and the upper bound is now the same abuse guard content
 * pricing uses, not a product rule.
 *
 * `dmResponseHours` is optional so an existing client that sends only the
 * two original fields keeps working and keeps its current window; omitting
 * it means "leave it alone", not "reset to 24".
 *
 * Its bounds are the product's, not arbitrary. The floor of 1 hour stops a
 * creator setting a window so short the payer is refunded before anyone
 * could realistically read the message — which would let someone collect on
 * the no-response stats of a rival, or simply look broken. The ceiling of
 * 336 hours (two weeks) is how long the platform is willing to hold a
 * payer's money against an undelivered reply; past that the right answer is
 * to refund, not to wait longer.
 */
export class UpdateDmSettingsDto {
  @IsBoolean()
  dmEnabled!: boolean;

  @IsInt()
  @Min(50)
  @Max(10_000_000)
  dmPrice!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(336)
  dmResponseHours?: number;
}
