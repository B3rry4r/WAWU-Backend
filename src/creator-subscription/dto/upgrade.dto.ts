import { IsEnum, IsOptional } from 'class-validator';
import { CreatorTier } from '../../../generated/prisma/enums';

/**
 * POST /creator-subscription/upgrade body.
 *
 * `to` is optional and defaults to Pro, so the existing client — which sends
 * no body at all — keeps working unchanged. It exists because there are three
 * tiers now: without it, "upgrade" could only ever mean Pro, and a Basic
 * subscriber wanting Pro Max would have to buy Pro first and upgrade again.
 */
export class UpgradeSubscriptionDto {
  @IsOptional()
  @IsEnum(CreatorTier, { message: 'to must be one of: pro, pro_max' })
  to?: CreatorTier;
}
