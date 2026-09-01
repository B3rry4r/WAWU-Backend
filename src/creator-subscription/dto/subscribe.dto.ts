import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreatorTier } from '../../../generated/prisma/enums';

/**
 * Body for POST /creator-subscription per the task brief's frozen endpoint
 * contract. `tier` is the only client-suppliable field — the naira amount
 * charged is always looked up server-side from PRICE_TABLE in
 * creator-subscription.service.ts, never accepted from the client
 * (conventions.md § Identity & format canon).
 */
export class SubscribeDto {
  @IsEnum(CreatorTier, { message: 'tier must be one of: basic, pro, pro_max' })
  tier!: CreatorTier;

  /**
   * A referral code, if they were given one.
   *
   * The DISCOUNT is not accepted from the client either — only the code is.
   * The percentage is looked up server-side and the naira amount recomputed
   * here, for the same reason `tier` is the only other field: a client that
   * can name its own price will.
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  referralCode?: string;
}
