import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /admin/content/:id/take-down body.
 *
 * Same shape as RejectContentDto and for the same reason: `reason` is
 * required in the DTO, not the service, so the 400 lands before anything is
 * written, and `@Matches(/\S/)` rather than `@IsNotEmpty()` so a single space
 * cannot pass as a reason. Unlike a rejection there is often nobody left to
 * read it (the creator's account may be the very thing that's gone) — it is
 * recorded on the audit row regardless, because the next admin looking at
 * this piece still needs to know why it came down.
 */
export class TakeDownContentDto {
  @IsString()
  @Matches(/\S/, {
    message:
      'reason is required — it is the only record of why this came down.',
  })
  @MaxLength(1000)
  reason!: string;
}
