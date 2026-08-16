import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /credits/purchase/verify per registry.json CreditPurchase
 * contract. Field names are snake_case deliberately — they echo
 * Flutterwave's own inline SDK callback payload (`transaction_id`,
 * `tx_ref`) verbatim, matching src/purchase/dto/verify-tip.dto.ts (wave 0).
 */
export class VerifyCreditPurchaseDto {
  @IsString()
  @IsNotEmpty()
  transaction_id!: string;

  @IsString()
  @IsNotEmpty()
  tx_ref!: string;
}
