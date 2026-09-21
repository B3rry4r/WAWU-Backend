import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The wire format for a month: "2023-03". Never a full date.
 *
 * The column is a real DATE and the API could have taken one, but a form that
 * asks which DAY somebody started a job is asking for a number they will
 * invent. Accepting "2023-03" makes month precision the contract rather than
 * a convention the client is trusted to follow, and it removes any question
 * of what "2023-03-15" was supposed to mean on the way back out.
 *
 * The regex is deliberately stricter than a date parser: "2023-3" and
 * "2023-13" are both rejected here rather than silently becoming March and
 * January-of-2024 further down.
 */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_MESSAGE = 'must be a month in the form YYYY-MM';

/** The cap on how many roles one profile may list. */
export const MAX_EXPERIENCE_ROWS = 15;

export class CreateProfileExperienceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  company!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string | null;

  @Matches(MONTH_PATTERN, { message: `startedOn ${MONTH_MESSAGE}` })
  startedOn!: string;

  /**
   * Omitted or null means this is the role they hold now.
   *
   * There is no `current` flag to send alongside it, for the reason the
   * schema gives: two fields that can contradict each other eventually do.
   */
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: `endedOn ${MONTH_MESSAGE}` })
  endedOn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

/**
 * Every field optional, because this is a PATCH: a client changing only an
 * end date must not have to resend the title and company it did not touch.
 * `@IsOptional()` treats an explicit null the same as absent, which is how
 * the rest of this service lets a caller clear a nullable field.
 */
export class UpdateProfileExperienceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string | null;

  @IsOptional()
  @Matches(MONTH_PATTERN, { message: `startedOn ${MONTH_MESSAGE}` })
  startedOn?: string;

  @IsOptional()
  @Matches(MONTH_PATTERN, { message: `endedOn ${MONTH_MESSAGE}` })
  endedOn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}
