import { IsNotEmpty, IsString } from 'class-validator';

/**
 * registry.json § ServiceApplication → POST /services/cac/apply/verify
 * body. Field names are snake_case verbatim — they mirror Flutterwave's own
 * inline-checkout SDK callback payload (`transaction_id`, `tx_ref`), which
 * the frontend forwards to this endpoint unchanged (conventions.md § Flutterwave).
 */
export class VerifyCacDto {
  @IsString()
  @IsNotEmpty()
  transaction_id!: string;

  @IsString()
  @IsNotEmpty()
  tx_ref!: string;
}
