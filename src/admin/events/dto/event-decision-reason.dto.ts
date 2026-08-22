import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Body for the two decisions that must be explained: POST
 * /admin/events/:id/reject and POST /admin/events/:id/remove.
 *
 * `reason` is REQUIRED, and required in the DTO rather than in the service so
 * the 400 arrives before anything is written. It is the only thing the host
 * can act on — "rejected", with nothing else, is a dead end for them and an
 * unanswerable support ticket for us. The service stores it on the audit row
 * AND denormalises it onto `Event.lastDecisionReason`, which is what
 * `GET /events/mine` shows the host.
 *
 * `@Matches(/\S/)` and not merely `@IsNotEmpty()`: a single space satisfies
 * IsNotEmpty and would ship an empty reason.
 *
 * One DTO for both endpoints, not two identical classes: reject and remove ask
 * the same question of the admin, and a copy would be the place the two
 * validations drift apart.
 */
export class EventDecisionReasonDto {
  @IsString()
  @Matches(/\S/, { message: 'reason is required — the host is shown it.' })
  @MaxLength(1000)
  reason!: string;
}
