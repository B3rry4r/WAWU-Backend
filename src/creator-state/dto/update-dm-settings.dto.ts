import { IsBoolean, IsInt, Max, Min } from 'class-validator';

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
 */
export class UpdateDmSettingsDto {
  @IsBoolean()
  dmEnabled!: boolean;

  @IsInt()
  @Min(50)
  @Max(10_000_000)
  dmPrice!: number;
}
