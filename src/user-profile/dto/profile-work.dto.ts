import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_WORKS, MAX_WORK_MEDIA } from '../profile-works';

/*
  These DTOs only say what TYPE each key is and put a roomy ceiling on how
  long a string may be before it is looked at. The real rules (the trim, the
  per-field length, tags, control characters, the link's shape, the year
  range) are in ../profile-works.ts and run in the service, so they read the
  same on create and on edit and need no second copy.

  `null` is meaningful on an edit: it clears an optional field. A required
  field cannot be cleared, so `ValidateIf(v !== undefined)` lets `null`
  through to `IsString`, which refuses it (a bare `IsOptional` would have
  skipped it and quietly done nothing).
*/
const ROOMY_LINE = 1000;
const ROOMY_PARAGRAPH = 4000;
const ROOMY_KEY = 2048;

const present = (_o: unknown, v: unknown) => v !== undefined;
const present_not_null = (_o: unknown, v: unknown) =>
  v !== undefined && v !== null;

export class CreateProfileWorkDto {
  @IsString()
  @MaxLength(ROOMY_LINE)
  title!: string;

  @IsString()
  @MaxLength(ROOMY_LINE)
  role!: string;

  @IsInt()
  year!: number;

  @IsOptional()
  @IsString()
  @MaxLength(ROOMY_LINE)
  client?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ROOMY_LINE)
  link?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ROOMY_LINE)
  category?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ROOMY_PARAGRAPH)
  description?: string | null;

  /**
   * The keys (or the `fileUrl`s) `POST /uploads/presign` returned for the
   * `profile/work` folder, first one the cover. Each must be this person's
   * own upload; anything else is a 400.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WORK_MEDIA)
  @IsString({ each: true })
  @MaxLength(ROOMY_KEY, { each: true })
  media?: string[];
}

export class UpdateProfileWorkDto {
  @ValidateIf(present)
  @IsString()
  @MaxLength(ROOMY_LINE)
  title?: string;

  @ValidateIf(present)
  @IsString()
  @MaxLength(ROOMY_LINE)
  role?: string;

  @ValidateIf(present)
  @IsInt()
  year?: number;

  @ValidateIf(present_not_null)
  @IsString()
  @MaxLength(ROOMY_LINE)
  client?: string | null;

  @ValidateIf(present_not_null)
  @IsString()
  @MaxLength(ROOMY_LINE)
  link?: string | null;

  @ValidateIf(present_not_null)
  @IsString()
  @MaxLength(ROOMY_LINE)
  category?: string | null;

  @ValidateIf(present_not_null)
  @IsString()
  @MaxLength(ROOMY_PARAGRAPH)
  description?: string | null;

  /** The whole list, replaced. [] clears it. */
  @ValidateIf(present)
  @IsArray()
  @ArrayMaxSize(MAX_WORK_MEDIA)
  @IsString({ each: true })
  @MaxLength(ROOMY_KEY, { each: true })
  media?: string[];
}

/** PUT /users/me/featured-works/order: every work id, in the order wanted. */
export class ReorderProfileWorksDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids!: string[];
}

/** GET /users/:wawuId/featured-works */
export class ListProfileWorksQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(ROOMY_LINE)
  category?: string;

  /** At most this many works (M33 shows three and "See all"). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WORKS)
  limit?: number;
}
