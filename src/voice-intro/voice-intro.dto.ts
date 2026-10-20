import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';

/** Letters of any script, marks, digits, spaces, apostrophes, hyphens and full stops: what a name is made of. */
const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} '’.-]*$/u;
const NAME_MESSAGE =
  'Use letters, spaces, apostrophes and hyphens only, starting with a letter.';

/** `POST /me/voice/name-preview`. */
export class NamePreviewDto {
  /** The name to say. */
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString({ message: 'name must be text.' })
  @Length(1, 60, { message: 'Type your name, up to 60 characters.' })
  @Matches(NAME_SHAPE, { message: NAME_MESSAGE })
  name!: string;

  /** How it sounds ("Ah-DEH-oh-lah"), when the plain spelling is not said right. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString({ message: 'phonetic must be text.' })
  @Length(1, 80, { message: 'Type the sound, up to 80 characters.' })
  @Matches(NAME_SHAPE, { message: NAME_MESSAGE })
  phonetic?: string;
}

/** `PUT /me/voice/name`. */
export class SaveNameDto {
  /** The spelling to keep for how the name is said; null puts it back to the plain name. */
  @ApiProperty({ type: String, nullable: true, minLength: 1, maxLength: 80 })
  @ValidateIf((o: SaveNameDto) => o.phonetic !== null)
  @IsString({ message: 'phonetic must be text or null.' })
  @Length(1, 80, { message: 'Type the sound, up to 80 characters.' })
  @Matches(NAME_SHAPE, { message: NAME_MESSAGE })
  phonetic!: string | null;
}

/** `PUT /me/voice-intro/text`. The limit is a setting, answered as `voice_text_too_long`. */
export class VoiceIntroTextDto {
  @ApiProperty({ minLength: 1, maxLength: 20000 })
  @IsString({ message: 'text must be text.' })
  @Length(1, 20000, { message: 'Write what your Voice Intro should say.' })
  text!: string;
}

/** `POST /me/voice-intro/consent`: the line exactly as `GET /me/voice-intro` served it. */
export class VoiceConsentDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString({ message: 'line must be text.' })
  @Length(1, 1000, { message: 'Send the words you agree to.' })
  line!: string;
}

/** `POST /me/voice-intro/sample`: the `fileUrl` `POST /uploads/presign` gave for the folder `voice/sample`, after `POST /uploads/confirm`. */
export class VoiceSampleDto {
  @ApiProperty({ minLength: 1, maxLength: 2048 })
  @IsString({ message: 'fileUrl must be text.' })
  @Length(1, 2048, { message: 'Send the link of your recording.' })
  fileUrl!: string;
}
