import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  SUSPENSION_REASONS,
  type SuspensionReason,
} from '../../common/suspension/user-suspension';

/** The longest note a moderator may leave on a suspension or a lift. */
export const SUSPENSION_NOTE_MAX = 1000;

/** POST /admin/users/:id/suspend. */
export class SuspendUserDto {
  /** Why, from the short fixed list the report sheet uses. */
  @IsIn(SUSPENSION_REASONS)
  reason!: SuspensionReason;

  /** What the moderator saw. Kept with the suspension and in the audit trail; the person is never shown it. */
  @IsOptional()
  @IsString()
  @MaxLength(SUSPENSION_NOTE_MAX)
  note?: string;

  /** The report that led to it, when there was one. */
  @IsOptional()
  @IsUUID('all')
  reportId?: string;
}

/** POST /admin/users/:id/lift. */
export class LiftSuspensionDto {
  /** Why it is lifted. Kept in the audit trail. */
  @IsOptional()
  @IsString()
  @MaxLength(SUSPENSION_NOTE_MAX)
  note?: string;
}
