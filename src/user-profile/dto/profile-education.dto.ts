import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** See profile-work.dto.ts: types here, the rules in ../profile-works.ts. */
const ROOMY_LINE = 1000;
const present = (_o: unknown, v: unknown) => v !== undefined;
const present_not_null = (_o: unknown, v: unknown) =>
  v !== undefined && v !== null;

export class CreateProfileEducationDto {
  @IsString()
  @MaxLength(ROOMY_LINE)
  school!: string;

  @IsOptional()
  @IsString()
  @MaxLength(ROOMY_LINE)
  field?: string | null;

  @IsInt()
  startYear!: number;

  /** Omitted or null means still studying there. */
  @IsOptional()
  @IsInt()
  endYear?: number | null;
}

export class UpdateProfileEducationDto {
  @ValidateIf(present)
  @IsString()
  @MaxLength(ROOMY_LINE)
  school?: string;

  @ValidateIf(present_not_null)
  @IsString()
  @MaxLength(ROOMY_LINE)
  field?: string | null;

  @ValidateIf(present)
  @IsInt()
  startYear?: number;

  /** null means still studying there. */
  @ValidateIf(present_not_null)
  @IsInt()
  endYear?: number | null;
}
