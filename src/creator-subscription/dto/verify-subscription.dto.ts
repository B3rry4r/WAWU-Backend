import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /creator-subscription/verify. Field names are snake_case
 * deliberately — they echo Flutterwave's own inline SDK callback payload
 * (`transaction_id`, `tx_ref`) verbatim, matching
 * src/purchase/dto/verify-tip.dto.ts's precedent. No `tier` field here: the
 * intended tier is recovered server-side from the pending attempt recorded
 * at POST /creator-subscription (or /upgrade) time, keyed by `tx_ref` — see
 * creator-subscription.service.ts's `pendingAttempts` doc comment for why.
 */
export class VerifySubscriptionDto {
  @IsString()
  @IsNotEmpty()
  transaction_id: string;

  @IsString()
  @IsNotEmpty()
  tx_ref: string;
}
