import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Input shape for CreditSpendService.record(). NOT a controller-bound DTO —
 * registry.json declares zero HTTP endpoints for CreditSpend (it is an
 * append-only ledger row written as a side effect of
 * `POST /communities/:id/messages`, owned by the CommunityMessage resource,
 * not exposed as its own route). Kept as a class-validator DTO anyway so
 * this internal entry point still rejects a malformed caller payload the
 * same way a controller-bound DTO would (validated explicitly in the
 * service — see conventions.md § Validation for the pattern this mirrors).
 *
 * `creditsSpent` is deliberately NOT a field here: registry.json documents
 * it as "always 1" and docs/02_TECHNICAL_CONTEXT.md §2.4 repeats it — the
 * service hardcodes 1 rather than trusting a caller-supplied count.
 */
export class CreateCreditSpendDto {
  @IsString()
  @IsNotEmpty()
  userWawuId!: string;

  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @IsString()
  @IsNotEmpty()
  creatorWawuId!: string;
}
