import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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

/**
 * `POST /ai-tools/dubbing/jobs` (AITOOLS-05). The Idempotency-Key is a header.
 * The file is one the person uploaded through `POST /uploads/presign` (folder
 * `ai/input-audio` or `ai/input-video`) and confirmed; the Hub reads its length
 * itself. One language a job.
 */
export class CreateDubbingJobDto {
  /** The `key` `POST /uploads/presign` gave for the person's own file. Another person's key is `404 not_found`. */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'fileKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the file you uploaded.' })
  fileKey!: string;

  /** The language to hear the file in: a code from the list `GET /ai-tools` gives (`input.file.dubbing.languages`). Another is `422 ai_language_unsupported`. */
  @ApiProperty({ pattern: '^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$' })
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/, {
    message: 'targetLanguage must be a language code from the list.',
  })
  @IsString({ message: 'targetLanguage must be text.' })
  targetLanguage!: string;

  /** The language spoken in the file, from the same list. Left out: the language is detected. */
  @ApiPropertyOptional({ pattern: '^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$' })
  @IsOptional()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/, {
    message: 'sourceLanguage must be a language code from the list.',
  })
  @IsString({ message: 'sourceLanguage must be text.' })
  sourceLanguage?: string;

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

  /** AITOOLS-07: `true` lists only the results the person saved to their library; `false` lists only the ones not saved. Absent: every job, as before. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  saved?: boolean;
}

/** Body for `POST /ai-tools/own-voice/consent` (AITOOLS-07): the words the Hub served in `consent.line`, sent back unchanged. */
export class OwnVoiceConsentDto {
  @ApiProperty()
  @IsString({ message: 'line must be text.' })
  @Length(1, 500)
  line!: string;
}

/** The shape of an aspect ratio a picture or video route reads (`1:1`, `16:9`); the tool checks it against its own list. */
const SHAPE = /^\d{1,2}:\d{1,2}$/;

/**
 * `POST /ai-tools/image/jobs` (AITOOLS-09, R-109). The Idempotency-Key is a
 * header. The description is never stored: the job keeps only how long it was.
 */
export class CreateImageJobDto {
  /** What the picture shows, in words. */
  @ApiProperty({ minLength: 1, maxLength: MOST_PROMPT_CHARACTERS })
  @MinLength(1, { message: 'Describe what you want to see.' })
  @MaxLength(MOST_PROMPT_CHARACTERS, {
    message: 'That description is too long.',
  })
  @IsString({ message: 'prompt must be text.' })
  prompt!: string;

  /** The shape: one of `input.options.shapes` from `GET /ai-tools` (`1:1`, `4:5`, `9:16`, `16:9`). Left out: square. */
  @ApiPropertyOptional({ pattern: '^\\d{1,2}:\\d{1,2}$' })
  @IsOptional()
  @Matches(SHAPE, { message: 'shape must look like 1:1 or 16:9.' })
  @IsString({ message: 'shape must be text.' })
  shape?: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (action `image_per_use`, units 1). A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/**
 * `POST /ai-tools/photo-edit/jobs` (AITOOLS-09): the same description, shape
 * and quote as Make an image, with the person's own photo.
 */
export class CreatePhotoEditJobDto extends CreateImageJobDto {
  /** The `key` `POST /uploads/presign` gave for the person's photo (folder `ai/input-image`). Another person's key is `404 not_found`. */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'photoKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the photo you uploaded.' })
  photoKey!: string;
}

/** `POST /ai-tools/video/jobs` (AITOOLS-10, R-109). The Idempotency-Key is a header. */
export class CreateVideoJobDto {
  /** What happens in the clip, in words. */
  @ApiProperty({ minLength: 1, maxLength: MOST_PROMPT_CHARACTERS })
  @MinLength(1, { message: 'Describe what you want to see.' })
  @MaxLength(MOST_PROMPT_CHARACTERS, {
    message: 'That description is too long.',
  })
  @IsString({ message: 'prompt must be text.' })
  prompt!: string;

  /** Wide (`16:9`) or tall (`9:16`): one of `input.options.shapes`. Left out: wide. */
  @ApiPropertyOptional({ pattern: '^\\d{1,2}:\\d{1,2}$' })
  @IsOptional()
  @Matches(SHAPE, { message: 'shape must look like 16:9 or 9:16.' })
  @IsString({ message: 'shape must be text.' })
  shape?: string;

  /** How long the clip is, in whole seconds: one of `input.options.lengths` (4, 6 or 8). It prices the job. */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MOST_SECONDS })
  @Max(MOST_SECONDS, { message: 'That length is too long.' })
  @Min(1, { message: 'Pick a length.' })
  @IsInt({ message: 'seconds must be a whole number of seconds.' })
  seconds!: number;

  /** The `key` of a photo to start from (folder `ai/input-image`). Left out: the clip is made from the words alone. */
  @ApiPropertyOptional({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsOptional()
  @IsString({ message: 'photoKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the photo you uploaded.' })
  photoKey?: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (action `video_per_sec`, units = `seconds`). */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/talking-photo/quote` (AITOOLS-10): the voice to price. Exactly one of the two. */
export class QuoteTalkingPhotoDto {
  /** The `key` of a voice recording the person uploaded (folder `ai/input-audio`, MP3 or WAV). */
  @ApiPropertyOptional({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsOptional()
  @IsString({ message: 'audioKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, {
    message: 'Send the recording you uploaded.',
  })
  audioKey?: string;

  /** The id of one of the person's own finished voice results whose audio is the voice. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', {
    message: 'sourceJobId must be the id of a finished result.',
  })
  sourceJobId?: string;
}

/** `POST /ai-tools/talking-photo/jobs` (AITOOLS-10). The Idempotency-Key is a header. */
export class CreateTalkingPhotoJobDto extends QuoteTalkingPhotoDto {
  /** The `key` of the person's photo (folder `ai/input-image`). */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'photoKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the photo you uploaded.' })
  photoKey!: string;

  /** `quoteToken` from `POST /ai-tools/talking-photo/quote` (sent with the same voice). A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/jobs/{id}/piece` (AITOOLS-08): which output of the finished job becomes a piece. */
export class MakePieceDto {
  /** The place of the output in the job's `outputs`, from 0. */
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 20 })
  @Max(20, { message: 'outputIndex is not one of the job’s outputs.' })
  @Min(0, { message: 'outputIndex is not one of the job’s outputs.' })
  @IsInt({ message: 'outputIndex must be a whole number.' })
  outputIndex!: number;
}

/** The same body for every tool that takes a file and a quote: the key of the person's own file and the quote they saw. */
class FileJobBase {
  /** The `key` `POST /uploads/presign` gave for the person's own file. Another person's key is `404 not_found`. */
  @ApiProperty({ minLength: 1, maxLength: MOST_KEY_CHARACTERS })
  @IsString({ message: 'fileKey must be text.' })
  @Length(1, MOST_KEY_CHARACTERS, { message: 'Send the file you uploaded.' })
  fileKey!: string;

  /** `quoteToken` from the quote route of the tool (sent with the same `fileKey`). A different cost now is `409 quote_changed`. */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/voice-changer/jobs` (AITOOLS-11, R-109). The Idempotency-Key is a header. */
export class CreateVoiceChangerJobDto extends FileJobBase {
  /** The voice to hear it in: an id from `GET /ai-tools` (`voices`), `own` for the person's saved voice when `GET /ai-tools/my-voice` says `ready`. */
  @ApiProperty()
  @IsString({ message: 'voiceId must be text.' })
  @Matches(/^[a-z0-9_-]{1,40}$/, {
    message: 'Pick one of the voices on the list.',
  })
  voiceId!: string;
}

/** One line of a scene: the words and the voice that says them. */
export class DialogueLineDto {
  /** The words. A line with no words in it is refused by the Hub with its own sentence and nothing held. */
  @ApiProperty({ minLength: 0, maxLength: MOST_CHARACTERS })
  @Length(0, MOST_CHARACTERS, { message: 'That line is too long.' })
  @IsString({ message: 'text must be text.' })
  text!: string;

  /** A voice id from `GET /ai-tools` (`voices`), or `own` for the person's saved voice. */
  @ApiProperty()
  @IsString({ message: 'voiceId must be text.' })
  @Matches(/^[a-z0-9_-]{1,40}$/, {
    message: 'Pick one of the voices on the list.',
  })
  voiceId!: string;
}

/** `POST /ai-tools/dialogue/jobs` (AITOOLS-11, R-109). The Idempotency-Key is a header. */
export class CreateDialogueJobDto {
  /** The lines of the scene, in order, up to 10 different voices and the character limit in `GET /ai-tools` (`input.maxCharacters`). */
  @ApiProperty({ type: () => [DialogueLineDto], minItems: 1, maxItems: 200 })
  @ArrayMaxSize(200, { message: 'That is too many lines.' })
  @ArrayMinSize(1, { message: 'Write at least one line.' })
  @ValidateNested({ each: true })
  @Type(() => DialogueLineDto)
  @IsArray({ message: 'lines must be a list.' })
  lines!: DialogueLineDto[];

  /** `quoteToken` from the `POST /points/quote` the person saw (action `dialogue_per_min`, units = the minutes the characters make). */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/my-voice` (AITOOLS-11, R-109). The Idempotency-Key is a header. */
export class CreateMyVoiceJobDto extends FileJobBase {
  /** The name the person gives their voice. It stays on the Hub; the provider is told a plain name. */
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @Length(1, 60, { message: 'Give your voice a name of 1 to 60 characters.' })
  @IsString({ message: 'name must be text.' })
  name!: string;

  /** The words the person agreed to: `consent.line` from `GET /ai-tools/my-voice`, sent back unchanged. Any other words are `409 own_voice_consent_line_changed`. */
  @ApiProperty({ maxLength: 500 })
  @Length(1, 500, { message: 'Send the words you agreed to.' })
  @IsString({ message: 'consentLine must be text.' })
  consentLine!: string;
}

/** `POST /ai-tools/video-music/jobs` (AITOOLS-12, R-109). The Idempotency-Key is a header. */
export class CreateVideoMusicJobDto extends FileJobBase {
  /** The mood in words, up to the limit in `GET /ai-tools`. Left out: the music follows the video alone. */
  @ApiPropertyOptional({ maxLength: MOST_PROMPT_CHARACTERS })
  @IsOptional()
  @MaxLength(MOST_PROMPT_CHARACTERS, {
    message: 'That description is too long.',
  })
  @IsString({ message: 'description must be text.' })
  description?: string;
}

/** `POST /ai-tools/stems/jobs` (AITOOLS-12, R-109). The Idempotency-Key is a header. */
export class CreateStemsJobDto extends FileJobBase {
  /** Two parts (the voice and the rest) or six. Left out: two. */
  @ApiPropertyOptional({ enum: [2, 6] })
  @IsOptional()
  @IsIn([2, 6], { message: 'parts must be 2 or 6.' })
  parts?: 2 | 6;
}

/** `POST /ai-tools/audiobook/jobs` (AITOOLS-13, R-109). The Idempotency-Key is a header. Send `text`, or the `fileKey` of a text file uploaded to `ai/input-doc`. */
export class CreateAudiobookJobDto {
  /** The words to read. Never stored beyond the job: the Hub keeps them in a private file until the job ends. */
  @ApiPropertyOptional({ maxLength: MOST_CHARACTERS })
  @IsOptional()
  @Length(1, MOST_CHARACTERS, { message: 'That text is too long.' })
  @IsString({ message: 'text must be text.' })
  text?: string;

  /** Instead of `text`: the key of a plain text file the person uploaded (`POST /uploads/presign` with the folder `ai/input-doc`, then `POST /uploads/confirm`). */
  @ApiPropertyOptional()
  @IsOptional()
  @Length(1, 512, { message: 'fileKey must come from an upload.' })
  @IsString({ message: 'fileKey must be text.' })
  fileKey?: string;

  /** A voice id from `GET /ai-tools`. */
  @ApiProperty()
  @IsString({ message: 'voiceId must be text.' })
  @Matches(/^[a-z0-9_-]{1,40}$/, {
    message: 'Pick one of the voices on the list.',
  })
  voiceId!: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (action `audiobook_per_min`, units = the minutes the characters make). */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** What a podcast is made from: a `text` or a `url` (exactly one). */
export class PodcastSourceDto {
  @ApiPropertyOptional({ maxLength: MOST_CHARACTERS })
  @IsOptional()
  @Length(1, MOST_CHARACTERS, { message: 'That text is too long.' })
  @IsString({ message: 'text must be text.' })
  text?: string;

  /** A web link: `https` only, at most 2,000 characters. The Hub never opens it. */
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @MaxLength(4000, { message: 'That link is too long.' })
  @IsString({ message: 'url must be text.' })
  url?: string;
}

/** `POST /ai-tools/podcast/jobs` (AITOOLS-13, R-109). The Idempotency-Key is a header. */
export class CreatePodcastJobDto {
  @ApiProperty({ type: () => PodcastSourceDto })
  @ValidateNested()
  @Type(() => PodcastSourceDto)
  source!: PodcastSourceDto;

  /** `conversation`: two voices talk it over. `bulletin`: one host reads it. */
  @ApiProperty({ enum: ['conversation', 'bulletin'] })
  @IsIn(['conversation', 'bulletin'], {
    message: 'mode must be conversation or bulletin.',
  })
  mode!: 'conversation' | 'bulletin';

  /** Voice ids from `GET /ai-tools`: one for a bulletin, two for a conversation (host, then guest). */
  @ApiProperty({ type: [String], minItems: 1, maxItems: 2 })
  @ArrayMaxSize(2, { message: 'Pick one voice or two.' })
  @ArrayMinSize(1, { message: 'Pick one voice or two.' })
  @Matches(/^[a-z0-9_-]{1,40}$/, {
    each: true,
    message: 'Pick voices from the list.',
  })
  @IsArray({ message: 'voiceIds must be a list.' })
  voiceIds!: string[];

  /** How long: `short` (under 3 minutes), `standard` (about 3 to 7) or `long` (over 7). */
  @ApiProperty({ enum: ['short', 'standard', 'long'] })
  @IsIn(['short', 'standard', 'long'], {
    message: 'duration must be short, standard or long.',
  })
  duration!: 'short' | 'standard' | 'long';

  /** Two letters from the list in `GET /ai-tools` (`input.podcast.languages`). */
  @ApiProperty({ minLength: 2, maxLength: 2 })
  @Matches(/^[A-Za-z]{2}$/, { message: 'Pick a language from the list.' })
  @IsString({ message: 'language must be text.' })
  language!: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (the action for the length chosen, units 1). */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}
