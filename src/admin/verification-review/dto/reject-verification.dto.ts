import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /admin/verification/:id/reject body.
 *
 * `reason` is REQUIRED in the DTO so the 400 arrives before anything is
 * written. The applicant can resubmit through the existing
 * `POST /verification/submissions/:id/resubmit`, which only accepts a REJECTED
 * submission — so the reason is not a courtesy, it is the instruction telling
 * them what to change before they use it.
 */
export class RejectVerificationDto {
  @IsString()
  @Matches(/\S/, { message: 'reason is required — the applicant is shown it.' })
  @MaxLength(1000)
  reason!: string;
}
