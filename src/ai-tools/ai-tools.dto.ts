import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

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
