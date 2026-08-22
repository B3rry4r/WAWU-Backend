import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /admin/kyc/:id/reject body.
 *
 * `reason` is REQUIRED, and required in the DTO rather than only in the
 * service so the 400 arrives before anything is written. It is the only thing
 * the creator can act on: KYC is the gate on getting paid, and "rejected" with
 * no reason leaves them unable to earn and unable to fix it.
 *
 * `@Matches(/\S/)` and not merely `@IsNotEmpty()`: a single space satisfies
 * IsNotEmpty and would ship an empty reason. Same rule, same wording as
 * ../../content-review/dto/reject-content.dto.ts — the two surfaces refuse
 * identically so a reviewer never has to remember which is which.
 */
export class RejectKycDto {
  @IsString()
  @Matches(/\S/, { message: 'reason is required — the creator is shown it.' })
  @MaxLength(1000)
  reason!: string;
}
