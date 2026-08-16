import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /content/:id/unlock/verify per registry.json ContentPiece
 * contract. snake_case fields echo Flutterwave's own inline SDK callback
 * payload verbatim (mirrors src/purchase/dto/verify-tip.dto.ts).
 */
export class VerifyUnlockDto {
  @IsString()
  @IsNotEmpty()
  transaction_id: string;

  @IsString()
  @IsNotEmpty()
  tx_ref: string;
}
