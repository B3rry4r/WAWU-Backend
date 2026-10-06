import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LEGAL_MATTER_VALUES } from '../legal-intake-questions';

/**
 * Postgres text cannot hold a NUL, and a pasted one would be a 500 from the
 * database. It is taken out here, with the spaces at either end, before the
 * length checks run, so a message of only NULs and spaces is refused as empty.
 */
const NUL = String.fromCharCode(0);
const cleanText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(NUL).join('').trim() : value;

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

export class SendChatMessageDto {
  /**
   * Bounded at both ends. A minimum because an empty turn burns a model call
   * and tells the consultant nothing; a maximum because this is a chat box,
   * and somebody pasting a whole contract into it should attach the document
   * instead — where the consultant can actually open it.
   */
  @Transform(cleanText)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

/**
 * Start the chat that writes the brief. The matter is optional: a person who
 * tapped a quick reply names it, a person who just started typing does not.
 */
export class StartAssistantDto {
  @IsOptional()
  @IsIn(LEGAL_MATTER_VALUES)
  matter?: string;
}

/**
 * One message to the assistant. Trimmed before it is checked, so a message of
 * nothing but spaces is refused instead of saved as an empty bubble. The
 * ceiling is a chat box's: a contract belongs in an attachment, where the
 * consultant can open it.
 */
export class SendAssistantMessageDto {
  @Transform(cleanText)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  /** The matter a quick reply names. Only used while none is settled. */
  @IsOptional()
  @IsIn(LEGAL_MATTER_VALUES)
  matter?: string;
}
