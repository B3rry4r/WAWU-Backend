import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { VERIFICATION_KINDS } from '../../common/verification/verification-state';

/** POST /verification/purchase - which of the two ticks is being bought. */
export class StartVerificationPurchaseDto {
  @IsIn(VERIFICATION_KINDS as unknown as string[])
  kind!: 'creator' | 'professional';
}

/**
 * POST /verification/purchase/verify.
 *
 * snake_case fields echo Flutterwave's own inline SDK callback payload
 * verbatim, the same way `VerifyUnlockDto` and `VerifyTipDto` do. Renaming
 * them here would mean every checkout call site in the app had to remember
 * which endpoint wanted which spelling.
 */
export class VerifyVerificationPurchaseDto {
  @IsString()
  @IsNotEmpty()
  transaction_id!: string;

  @IsString()
  @IsNotEmpty()
  tx_ref!: string;
}
