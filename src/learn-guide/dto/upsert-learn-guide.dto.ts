import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { GuideKind } from '../../../generated/prisma/enums';

/**
 * `kind` is the LearnGuide column's own enum — `country | article | template`.
 *
 * It used to be `guide | playbook | export | compliance`, a vocabulary that
 * exists nowhere else: every one of those four values is rejected by Postgres,
 * and none of the three the column actually accepts could get past validation,
 * so POST /learn/guides could never succeed at all. The service papered over
 * the mismatch with `as never`, which silenced the only compiler error that
 * would have caught it.
 *
 * `country | article | template` is what the web app renders
 * (WAWU-Web `src/types/learn.ts` → `LearnGuideKind`), what the read-side
 * filter DTO already validates against, and what the seed data uses — so the
 * DTO is the side that was wrong, not the enum.
 */
export class UpsertLearnGuideDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(400) subtitle?: string;
  @IsOptional() @IsIn(Object.values(GuideKind)) kind?: GuideKind;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  @IsOptional() @IsInt() @Min(1) readMinutes?: number;
  @IsOptional() @IsISO8601() updated?: string;

  /** Object-storage URL from POST /uploads/presign. */
  @IsOptional()
  @IsUrl({}, { message: 'fileUrl must be a full link' })
  @MaxLength(600)
  fileUrl?: string;
}
