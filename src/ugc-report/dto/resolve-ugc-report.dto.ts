import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /admin/reports/:id/resolve. */
export class ResolveUgcReportDto {
  /** `dismiss`: nothing wrong. `take_down`: the item comes down (a piece through content take-down; a comment, community message or chat message is deleted). */
  @IsIn(['dismiss', 'take_down'])
  action!: 'dismiss' | 'take_down';

  /** Why. Required for a take-down (it is the only record of why it came down); optional for a dismissal. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
