import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
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

/** The longest description this route will read: a request bound, not a product figure (the limit a person is held to is a setting). */
const MOST_PROMPT_CHARACTERS = 20_000;
/** The longest length this route will read, in seconds: a request bound (the real limit is a setting, named when it refuses). */
const MOST_SECONDS = 3600;
/** The longest storage key this route will read: a request bound. */
const MOST_KEY_CHARACTERS = 300;

/**
 * `POST /ai-tools/sound-effect/jobs` (AITOOLS-03). The Idempotency-Key is a
 * header. The description is never stored: the job keeps only how long it was.
 */
export class CreateSoundEffectJobDto {
  /** What the sound is, in words. */
  @ApiProperty({ minLength: 1, maxLength: MOST_PROMPT_CHARACTERS })
  @MinLength(1, { message: 'Describe what you want to hear.' })
  @MaxLength(MOST_PROMPT_CHARACTERS, {
    message: 'That description is too long.',
  })
  // Last, so it is the first to answer: words that are not text say so.
  @IsString({ message: 'prompt must be text.' })
  prompt!: string;

  /** How long the sound is, in seconds, from 0.5 up to the longest `GET /ai-tools` lists. Left out: the tool chooses. The price is the same whatever the length. */
  @ApiPropertyOptional({ type: 'number', minimum: 0.5, maximum: MOST_SECONDS })
  @IsOptional()
  @Max(MOST_SECONDS, { message: 'That length is too long.' })
  @Min(0.5, { message: 'The shortest sound is half a second.' })
  // Last, so it is the first to answer: a value that is not a number says so
  // (the first message is the one a person sees).
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'durationSeconds must be a number of seconds.' },
  )
  durationSeconds?: number;

  /** `quoteToken` from the `POST /points/quote` the person saw. A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/music/jobs` (AITOOLS-03). The Idempotency-Key is a header. */
export class CreateMusicJobDto {
  /** What the track is like, in words. */
  @ApiProperty({ minLength: 1, maxLength: MOST_PROMPT_CHARACTERS })
  @MinLength(1, { message: 'Describe what you want to hear.' })
  @MaxLength(MOST_PROMPT_CHARACTERS, {
    message: 'That description is too long.',
  })
  // Last, so it is the first to answer: words that are not text say so.
  @IsString({ message: 'prompt must be text.' })
  prompt!: string;

  /** How long the track is, in whole seconds, from 3 up to the longest `GET /ai-tools` lists. Left out: the tool chooses. The price is the same whatever the length. */
  @ApiPropertyOptional({ type: 'integer', minimum: 3, maximum: MOST_SECONDS })
  @IsOptional()
  @Max(MOST_SECONDS, { message: 'That length is too long.' })
  @Min(3, { message: 'The shortest track is 3 seconds.' })
  // Last, so it is the first to answer (see durationSeconds).
  @IsInt({ message: 'lengthSeconds must be a whole number of seconds.' })
  lengthSeconds?: number;

  /** True for a track without singing. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'instrumental must be true or false.' })
  instrumental?: boolean;

  /** `quoteToken` from the `POST /points/quote` the person saw. A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/**
 * `POST /ai-tools/captions/jobs` (AITOOLS-04). The Idempotency-Key is a
 * header. The file is one the person uploaded through `POST /uploads/presign`
 * (folder `ai/input-audio` or `ai/input-video`) and confirmed; the Hub reads
 * its length itself, so no length is sent.
 */
export class CreateCaptionsJobDto {
  /** The `key` `POST /uploads/presign` gave for the person's own file. Another person's key is `404 not_found`. */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'fileKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the file you uploaded.' })
  fileKey!: string;

  /** The language spoken, as an ISO 639 code (`en`, `yo`, `fra`). Left out: the language is detected. */
  @ApiPropertyOptional({ pattern: '^[a-z]{2,3}$' })
  @IsOptional()
  @IsString({ message: 'languageCode must be text.' })
  @Matches(/^[a-z]{2,3}$/, {
    message: 'languageCode must be a two or three letter language code.',
  })
  languageCode?: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (sent with the same `fileKey`). A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/captions/quote` and `POST /ai-tools/clean-audio/quote` (AITOOLS-04): the file to price. */
export class QuoteFileDto {
  /** The `key` `POST /uploads/presign` gave for the person's own file. Another person's key is `404 not_found`. */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'fileKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the file you uploaded.' })
  fileKey!: string;
}

/** `POST /ai-tools/clean-audio/jobs` (AITOOLS-04): the same file and quote as Captions, with no language. */
export class CreateCleanAudioJobDto {
  /** The `key` `POST /uploads/presign` gave for the person's own file. Another person's key is `404 not_found`. */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'fileKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the file you uploaded.' })
  fileKey!: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (sent with the same `fileKey`). A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

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
