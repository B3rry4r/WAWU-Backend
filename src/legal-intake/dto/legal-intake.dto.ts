import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import { LEGAL_MATTER_VALUES } from '../legal-intake-questions';

export class StartIntakeDto {
  @IsIn(LEGAL_MATTER_VALUES)
  matter!: string;
}

/**
 * Answers are merged, so this is a partial by design — the app sends one
 * question at a time and a dropped request costs that answer, not the intake.
 *
 * The values are not typed further here: a single-choice answer is a string,
 * a multi-choice one an array, and a skipped one null. The service validates
 * every key against the question set for this matter, which is a stronger
 * check than a shape assertion — an unknown id is rejected outright.
 */
export class SaveAnswersDto {
  @IsObject()
  answers!: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({}, { each: true })
  documents?: string[];
}

export class IntakeQueueQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['completed', 'converted'])
  status?: string;
}
