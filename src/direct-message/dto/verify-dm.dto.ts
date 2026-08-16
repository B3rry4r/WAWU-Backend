import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /dm/:messageId/send/verify. Field names are snake_case
 * deliberately — they echo Flutterwave's own inline SDK callback payload
 * (`transaction_id`, `tx_ref`) verbatim, matching
 * src/purchase/dto/verify-tip.dto.ts's precedent.
 */
export class VerifyDmDto {
  @IsString()
  @IsNotEmpty()
  transaction_id: string;

  @IsString()
  @IsNotEmpty()
  tx_ref: string;
}
