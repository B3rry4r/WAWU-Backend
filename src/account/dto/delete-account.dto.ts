import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * The choices Z7's "Why are you leaving? (optional)" offers (SETTINGS-05). The
 * app writes the words; the Hub keeps the code. A new choice is added here and
 * in the app together, and needs no migration (the column is a string).
 */
export const LEAVING_REASONS = [
  'not_using_enough',
  'another_account',
  'privacy',
  'too_many_notifications',
  'something_else',
] as const;
export type LeavingReason = (typeof LEAVING_REASONS)[number];

/**
 * `DELETE /account` takes at most one optional field: why the person is
 * leaving. The global ValidationPipe ({ whitelist: true,
 * forbidNonWhitelisted: true }) still rejects any other body field with a 400
 * instead of silently ignoring it, and a value outside `LEAVING_REASONS` the
 * same. A request with no body, or `{}`, is what it always was.
 */
export class DeleteAccountDto {
  /** Why the person is leaving; left out when they did not say. */
  @ApiPropertyOptional({ enum: LEAVING_REASONS })
  @IsOptional()
  @IsIn(LEAVING_REASONS)
  reason?: LeavingReason;
}
