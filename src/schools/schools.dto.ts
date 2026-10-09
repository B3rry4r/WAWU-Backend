import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsCleanText } from '../admin/legal-documents/policy-input';
import { SCHOOL_CATEGORIES } from './school-admin.dto';
import { CURSOR_MAX_LENGTH } from './schools-cursor';

/** Upper bound on a search term, as GET /search has it. */
export const MAX_SCHOOL_QUERY_LENGTH = 100;

/**
 * A search term: trimmed, and an empty one counts as no term at all (an app
 * that sends `q=` while the box is empty gets the whole list). A value that
 * is not one string (`q=a&q=b`) stays as it came so the validators refuse it.
 */
export const trimmedQuery = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? undefined : t;
};

/** GET /schools */
export class ListPublicSchoolsDto {
  @IsOptional()
  @IsIn(SCHOOL_CATEGORIES)
  category?: (typeof SCHOOL_CATEGORIES)[number];

  /**
   * Matches a school's name or place, or the title of one of its shown
   * courses, ignoring case. Wildcard characters mean themselves.
   */
  @IsOptional()
  @Transform(trimmedQuery)
  @IsCleanText()
  @MaxLength(MAX_SCHOOL_QUERY_LENGTH)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /**
   * The `nextCursor` of the previous page: opaque, not to be built by hand,
   * and never longer than the longest one this server gives out.
   */
  @IsOptional()
  @IsString()
  @MaxLength(CURSOR_MAX_LENGTH)
  cursor?: string;
}
