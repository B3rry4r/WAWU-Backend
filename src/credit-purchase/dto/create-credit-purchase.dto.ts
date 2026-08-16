import { IsEnum } from 'class-validator';
import { CreditPack } from '../../../generated/prisma/enums';

/**
 * Body for POST /credits/purchase per registry.json CreditPurchase contract.
 * `pack` is the only client-suppliable field — amount/creditsGranted are
 * looked up server-side from PACK_TABLE in credit-purchase.service.ts, never
 * accepted from the client (conventions.md § Identity & format canon: money
 * fields are never client-suppliable when a canonical price exists).
 */
export class CreateCreditPurchaseDto {
  @IsEnum(CreditPack, { message: 'pack must be one of: starter, popular, pro' })
  pack!: CreditPack;
}
