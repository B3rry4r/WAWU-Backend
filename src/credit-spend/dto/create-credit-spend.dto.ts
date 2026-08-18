import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

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
 * `creditsSpent` USED to be absent here, with the service hardcoding 1. That
 * silently discarded `CommunityMessage.costInCredits` — a column that exists,
 * defaults to 1, and is the actual price charged to the sender. The ledger
 * therefore under-reported any message priced above the default, and the
 * host's attribution rollup disagreed with the balance actually debited.
 * It is now an optional caller-supplied count (defaulting to 1, matching the
 * schema default) so the ledger records what was really spent.
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

  /** The real cost of the message being recorded — `CommunityMessage.costInCredits`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  creditsSpent?: number;
}
