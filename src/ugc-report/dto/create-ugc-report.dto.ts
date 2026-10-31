import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  UGC_KINDS,
  UGC_NOTE_MAX,
  UGC_REASONS,
  type UgcKind,
  type UgcReason,
} from '../ugc-report.kinds';

/** POST /reports. One body for every kind of thing. */
export class CreateUgcReportDto {
  /** What is being reported. */
  @IsIn(UGC_KINDS)
  kind!: UgcKind;

  /** The id of that thing (a piece, comment, community message, chat message or paid question), or the person's wawuId for a profile. */
  @IsUUID('all')
  targetId!: string;

  /** Why, from the short fixed list. */
  @IsIn(UGC_REASONS)
  reason!: UgcReason;

  /** Anything the reporter wants a moderator to know. Optional. */
  @IsOptional()
  @IsString()
  @MaxLength(UGC_NOTE_MAX)
  note?: string;
}
