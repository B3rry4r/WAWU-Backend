import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /admin/content/:id/reject body.
 *
 * `reason` is REQUIRED, and required in the DTO rather than in the service so
 * the 400 arrives before anything is written. It is the only thing the
 * creator will be able to act on: they paid for the slot, and "rejected" with
 * no reason is a dead end for them and an unanswerable support ticket for us.
 *
 * `@Matches(/\S/)` and not merely `@IsNotEmpty()`: a single space satisfies
 * IsNotEmpty and would ship an empty reason.
 */
export class RejectContentDto {
  @IsString()
  @Matches(/\S/, { message: 'reason is required — the creator is shown it.' })
  @MaxLength(1000)
  reason!: string;
}
