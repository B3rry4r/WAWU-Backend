import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/** `PUT /ai-tools/receptionist` (AITOOLS-06, R-109). */
export class SaveReceptionistDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Length(1, 80, { message: 'Add your business name (up to 80 characters).' })
  @IsString({ message: 'businessName must be text.' })
  businessName!: string;

  /** What the business offers, in the person's own words. */
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Length(1, 2000, { message: 'Say what you offer (up to 2,000 characters).' })
  @IsString({ message: 'offer must be text.' })
  offer!: string;

  /** How it should reply (tone, length). Optional. */
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @MaxLength(1000, { message: 'That is too long (up to 1,000 characters).' })
  @IsString({ message: 'replyStyle must be text.' })
  replyStyle?: string;

  /** A code from `limits.languages`; English when left out. */
  @ApiPropertyOptional({ minLength: 2, maxLength: 2 })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, { message: 'Pick a language from the list.' })
  language?: string;

  /** A voice id from `voices`; the first when left out. */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[a-z0-9_-]{1,40}$/, { message: 'Pick a voice from the list.' })
  voiceId?: string;
}

/** `POST /ai-tools/receptionist/knowledge` (AITOOLS-06). Send `text` for a text, `url` for a web page, `fileKey` for a document (a text or a PDF uploaded to `ai/input-doc`). */
export class AddKnowledgeDto {
  @ApiProperty({ enum: ['text', 'url', 'file'] })
  @IsIn(['text', 'url', 'file'], { message: 'kind must be text, url or file.' })
  kind!: 'text' | 'url' | 'file';

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Length(1, 120, { message: 'Give it a name (up to 120 characters).' })
  @IsString({ message: 'name must be text.' })
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(400000, { message: 'That text is too long.' })
  @IsString({ message: 'text must be text.' })
  text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(4000, { message: 'That link is too long.' })
  @IsString({ message: 'url must be text.' })
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Length(1, 512, { message: 'fileKey must come from an upload.' })
  @IsString({ message: 'fileKey must be text.' })
  fileKey?: string;
}

/** `POST /ai-tools/receptionist/messages` (AITOOLS-06). The Idempotency-Key is a header. */
export class CreateReceptionistMessageDto {
  /** The person's message. Never logged by the Hub. */
  @ApiProperty({ minLength: 1, maxLength: 20000 })
  @Length(1, 20000, { message: 'Write your message.' })
  @IsString({ message: 'message must be text.' })
  message!: string;

  /** `quoteToken` from the `POST /points/quote` the person saw (action `receptionist_message`, units 1). */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}

/** `POST /ai-tools/receptionist/voice-sessions` (AITOOLS-06). The Idempotency-Key is a header. */
export class StartVoiceSessionDto {
  /** `quoteToken` from the `POST /points/quote` the person saw (action `receptionist_voice_per_min`, units = `limits.voiceMaxMinutes`). */
  @ApiProperty()
  @IsString({ message: 'quoteToken must be text.' })
  @Length(1, 1024, { message: 'quoteToken must come from a points quote.' })
  quoteToken!: string;
}
