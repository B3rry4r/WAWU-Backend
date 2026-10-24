import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * A request bound, not a product figure: the longest body this route will read.
 * The character LIMIT a person is held to is a setting (`GET /plans` `caps`),
 * answered as `points_cap_reached` with the cap named.
 */
const MOST_CHARACTERS = 200_000;

/** `POST /ai-tools/voiceover/jobs`. The Idempotency-Key is a header. */
export class CreateVoiceoverJobDto {
  /** The words to speak. Never stored: the job keeps only how long it was. */
  @ApiProperty({ minLength: 1, maxLength: MOST_CHARACTERS })
  @IsString({ message: 'text must be text.' })
  @Length(1, MOST_CHARACTERS, { message: 'Type or paste the words to speak.' })
  text!: string;

  /** A voice id from `GET /ai-tools`. */
  @ApiProperty()
  @IsString({ message: 'voiceId must be text.' })
  @Matches(/^[a-z0-9_-]{1,40}$/, {
    message: 'Pick one of the voices on the list.',
  })
  voiceId!: string;

  /** `quoteToken` from the `POST /points/quote` the person saw. A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/**
 * `POST /ai-tools/quick-voice/jobs` (AITOOLS-02): the same words, voice and
 * quote as VoiceOver; the quote is for the action `quick_voice_per_min`.
 */
export class CreateQuickVoiceJobDto extends CreateVoiceoverJobDto {}

/** `GET /ai-tools/jobs`: a cursor page (docs/contract/CONVENTIONS.md section 6). */
export class AiJobListQueryDto {
  /** `nextCursor` from the previous page. Opaque: send it back as given. Absent for the first page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /** Jobs per page, 1 to 100. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
