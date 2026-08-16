import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /tips/verify per registry.json Purchase contract. Field
 * names are snake_case deliberately — they echo Flutterwave's own inline
 * SDK callback payload (`transaction_id`, `tx_ref`) verbatim, matching the
 * shape the frontend receives from Flutterwave and forwards unmodified.
 */
export class VerifyTipDto {
  @IsString()
  @IsNotEmpty()
  transaction_id: string;

  @IsString()
  @IsNotEmpty()
  tx_ref: string;
}
