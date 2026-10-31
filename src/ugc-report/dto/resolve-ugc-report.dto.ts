import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  SUSPENSION_REASONS,
  type SuspensionReason,
} from '../../common/suspension/user-suspension';

/** What a moderator can do with a reported item. */
export const RESOLVE_ACTIONS = [
  'dismiss',
  'take_down',
  'take_down_and_suspend',
  'suspend',
] as const;
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

/** POST /admin/reports/:id/resolve. */
export class ResolveUgcReportDto {
  /**
   * `dismiss`: nothing wrong. `take_down`: the item comes down (a piece through content take-down; a comment, community
   * message or chat message is deleted); on a reported PROFILE it suspends the person (USER-SUSPEND, R-121).
   * `take_down_and_suspend`: the item comes down AND the person who made it is suspended. `suspend`: the person is
   * suspended and the item is left as it is (the way to act on a paid question, which carries money).
   */
  @IsIn(RESOLVE_ACTIONS)
  action!: ResolveAction;

  /** Why. Required for a take-down or a suspension (it is the only record of why); optional for a dismissal. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Why the person is suspended, from the same short list as a report. Defaults to the report's own reason. */
  @IsOptional()
  @IsIn(SUSPENSION_REASONS)
  suspendReason?: SuspensionReason;
}
