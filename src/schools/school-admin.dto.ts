import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  isEmail,
  isURL,
  IsUUID,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import {
  IsCleanText,
  isCleanText,
} from '../admin/legal-documents/policy-input';

export const SCHOOL_CATEGORIES = [
  'tech',
  'business',
  'creative',
  'languages',
  'vocational',
] as const;
export const COURSE_MODES = ['online', 'in_person', 'hybrid'] as const;

/**
 * PROVISIONAL(SCHOOLS-ADMIN-LIMITS, owner=YOU, why=no ruling gives the length of a school's text, the founding years or the seat range)
 *
 * Default (agent), owner may override: sizes that keep a card and a syllabus
 * readable, a founding year from 1800 to this year, a course of 1 to 520
 * weeks, a fee up to the largest Int kobo the column holds, 1 to 100000
 * seats. A bound the dashboard hits is a one-line change here.
 */
export const SCHOOL_LIMITS = {
  name: 120,
  location: 120,
  about: 4000,
  expertiseItems: 12,
  expertiseLength: 40,
  title: 160,
  weeks: 520,
  listItems: 60,
  listLength: 300,
  schedule: 120,
  capacity: 100_000,
  priceKoboMax: 2_147_483_647,
  foundedYearMin: 1800,
} as const;

const THIS_YEAR = () => new Date().getUTCFullYear();

/**
 * A PATCH field that may be left out but never sent as `null`: the column
 * behind it is required, so `null` is a 400 naming the field, not a database
 * error. (`@IsOptional()` lets `null` through; it stays only on the columns
 * that really clear to null.)
 */
const OptionalNotNull = () => ValidateIf((_o, v) => v !== undefined);

/**
 * `YYYY-MM-DD` that is a real calendar date, reads back unchanged, and that
 * Postgres can hold in a `date` column. Postgres has no year 0 (the year
 * before 1 AD is 1 BC), so `0000-..` is refused; years 0001 to 9999 are what
 * four digits can say and all are in its range.
 */
export function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  if (value.startsWith('0000-')) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function decorate(
  name: string,
  check: (v: unknown) => boolean,
  message: string,
) {
  return (options?: ValidationOptions) =>
    (object: object, propertyName: string) =>
      registerDecorator({
        name,
        target: object.constructor,
        propertyName,
        options: { message, ...options },
        validator: { validate: check },
      });
}

/**
 * Goes last in a field's decorators (nearest the property) so its message is
 * the one a `null` gets: validators report in that order and the API answers
 * with the first.
 */
const NotNull = decorate(
  'isNotNull',
  (v) => v !== null,
  '$property must not be null',
);

const IsCalendarDate = decorate(
  'isCalendarDate',
  isCalendarDate,
  '$property must be a real date (YYYY-MM-DD)',
);

/** Every item is clean text of at most `max` characters. */
const IsTextList = (max: number) =>
  decorate(
    'isTextList',
    (v) =>
      Array.isArray(v) &&
      v.every((x) => isCleanText(x) && (x as string).length <= max),
    `$property must be a list of text, each at most ${max} characters`,
  )();

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimmedList = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? (value as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : x))
    : value;
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : trimmed({ value });

const URL_OPTIONS = { protocols: ['https'], require_protocol: true };

/**
 * `@IsEmail` and `@IsUrl` run the validator library on whatever string they
 * are given, and it throws (a `URIError` on a lone surrogate) or lets a NUL
 * through to Postgres, which refuses it: a 500 where a 400 belongs. These two
 * look for a NUL or a lone surrogate first and answer `false` for it.
 */
const IsSafeEmail = decorate(
  'isEmail',
  (v) => isCleanText(v) && isEmail(v),
  '$property must be an email, with no null characters or broken characters',
);
const IsSafeUrl = decorate(
  'isUrl',
  (v) => isCleanText(v) && isURL(v as string, URL_OPTIONS),
  '$property must be a URL address (https), with no null characters or broken characters',
);

// ---- school ---------------------------------------------------------------

export class CreateSchoolDto {
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.name)
  name!: string;

  @IsIn(SCHOOL_CATEGORIES)
  category!: (typeof SCHOOL_CATEGORIES)[number];

  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.location)
  location!: string;

  @IsOptional()
  @IsInt()
  @Min(SCHOOL_LIMITS.foundedYearMin)
  @Max(THIS_YEAR())
  foundedYear?: number | null;

  @IsOptional()
  @Transform(trimmedList)
  @IsArray()
  @ArrayMaxSize(SCHOOL_LIMITS.expertiseItems)
  @IsTextList(SCHOOL_LIMITS.expertiseLength)
  expertise?: string[];

  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.about)
  about!: string;

  /** A storage URL. Empty or null clears it. */
  @IsOptional()
  @Transform(emptyToNull)
  @IsSafeUrl()
  @MaxLength(2000)
  logo?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsSafeUrl()
  @MaxLength(2000)
  applyUrl?: string | null;

  @Transform(trimmed)
  @IsSafeEmail()
  @MaxLength(254)
  reportEmail!: string;
}

/** Every field optional; `hidden` hides or shows the school. */
export class UpdateSchoolDto {
  @OptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.name)
  @NotNull()
  name?: string;

  @OptionalNotNull()
  @IsIn(SCHOOL_CATEGORIES)
  @NotNull()
  category?: (typeof SCHOOL_CATEGORIES)[number];

  @OptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.location)
  @NotNull()
  location?: string;

  @IsOptional()
  @IsInt()
  @Min(SCHOOL_LIMITS.foundedYearMin)
  @Max(THIS_YEAR())
  foundedYear?: number | null;

  @OptionalNotNull()
  @Transform(trimmedList)
  @IsArray()
  @ArrayMaxSize(SCHOOL_LIMITS.expertiseItems)
  @IsTextList(SCHOOL_LIMITS.expertiseLength)
  @NotNull()
  expertise?: string[];

  @OptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.about)
  @NotNull()
  about?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsSafeUrl()
  @MaxLength(2000)
  logo?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsSafeUrl()
  @MaxLength(2000)
  applyUrl?: string | null;

  @OptionalNotNull()
  @Transform(trimmed)
  @IsSafeEmail()
  @MaxLength(254)
  @NotNull()
  reportEmail?: string;

  @OptionalNotNull()
  @IsBoolean()
  @NotNull()
  hidden?: boolean;
}

export class ListSchoolsDto {
  @IsOptional()
  @IsIn(SCHOOL_CATEGORIES)
  category?: (typeof SCHOOL_CATEGORIES)[number];

  /** `true`: only hidden. `false`: only shown. Omitted: both. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** The `nextCursor` of the previous page: a school id. */
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

// ---- course ---------------------------------------------------------------

export class CreateCourseDto {
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.title)
  title!: string;

  @IsInt()
  @Min(1)
  @Max(SCHOOL_LIMITS.weeks)
  weeks!: number;

  @IsIn(COURSE_MODES)
  mode!: (typeof COURSE_MODES)[number];

  @IsOptional()
  @Transform(trimmedList)
  @IsArray()
  @ArrayMaxSize(SCHOOL_LIMITS.listItems)
  @IsTextList(SCHOOL_LIMITS.listLength)
  syllabus?: string[];

  @IsOptional()
  @Transform(trimmedList)
  @IsArray()
  @ArrayMaxSize(SCHOOL_LIMITS.listItems)
  @IsTextList(SCHOOL_LIMITS.listLength)
  outcomes?: string[];

  /** Whole kobo (CONVENTIONS section 1). */
  @IsInt()
  @Min(0)
  @Max(SCHOOL_LIMITS.priceKoboMax)
  priceKobo!: number;
}

export class UpdateCourseDto {
  @OptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.title)
  @NotNull()
  title?: string;

  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(SCHOOL_LIMITS.weeks)
  @NotNull()
  weeks?: number;

  @OptionalNotNull()
  @IsIn(COURSE_MODES)
  @NotNull()
  mode?: (typeof COURSE_MODES)[number];

  @OptionalNotNull()
  @Transform(trimmedList)
  @IsArray()
  @ArrayMaxSize(SCHOOL_LIMITS.listItems)
  @IsTextList(SCHOOL_LIMITS.listLength)
  @NotNull()
  syllabus?: string[];

  @OptionalNotNull()
  @Transform(trimmedList)
  @IsArray()
  @ArrayMaxSize(SCHOOL_LIMITS.listItems)
  @IsTextList(SCHOOL_LIMITS.listLength)
  @NotNull()
  outcomes?: string[];

  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(SCHOOL_LIMITS.priceKoboMax)
  @NotNull()
  priceKobo?: number;

  @OptionalNotNull()
  @IsBoolean()
  @NotNull()
  hidden?: boolean;
}

// ---- intake ---------------------------------------------------------------

export class CreateIntakeDto {
  /** The day classes start, YYYY-MM-DD. */
  @IsCalendarDate()
  startDate!: string;

  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.schedule)
  schedule!: string;

  /** Null or empty for an online intake. */
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.location)
  location?: string | null;

  @IsInt()
  @Min(1)
  @Max(SCHOOL_LIMITS.capacity)
  capacity!: number;
}

export class UpdateIntakeDto {
  @OptionalNotNull()
  @IsCalendarDate()
  @NotNull()
  startDate?: string;

  @OptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.schedule)
  @NotNull()
  schedule?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @IsCleanText()
  @MaxLength(SCHOOL_LIMITS.location)
  location?: string | null;

  /** Never below the seats already taken. */
  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(SCHOOL_LIMITS.capacity)
  @NotNull()
  capacity?: number;

  @OptionalNotNull()
  @IsBoolean()
  @NotNull()
  hidden?: boolean;
}
