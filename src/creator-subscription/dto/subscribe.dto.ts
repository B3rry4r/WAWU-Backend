import { IsEnum } from 'class-validator';
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
}
