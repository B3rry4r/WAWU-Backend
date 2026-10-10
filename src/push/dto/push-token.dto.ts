import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsCleanText } from '../../admin/legal-documents/policy-input';
import { EXPO_TOKEN_PATTERN } from '../push-config';

/*
 * Every string here is also `IsCleanText` (the rule GET /search and the
 * schools routes use): Postgres refuses a NUL in text, and a NUL that passed
 * validation used to answer 500 instead of 400.
 */

/** POST /push-tokens. */
export class RegisterPushTokenDto {
  /** The phone's Expo push token, `ExponentPushToken[...]` or `ExpoPushToken[...]`, exactly as the app got it. */
  @IsString()
  @MaxLength(300)
  @Matches(EXPO_TOKEN_PATTERN, {
    message: 'expoPushToken must be an Expo push token',
  })
  @IsCleanText()
  expoPushToken!: string;

  @IsIn(['android', 'ios'])
  platform!: 'android' | 'ios';

  /** The phone's own id, if the app has one. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @IsCleanText()
  deviceId?: string;

  /** A name for the phone ("Pixel 8"), if the app has one. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @IsCleanText()
  deviceLabel?: string;
}

/** DELETE /push-tokens. The token is in the body, never the URL, so it stays out of access logs. */
export class RemovePushTokenDto {
  @IsString()
  @MaxLength(300)
  @Matches(EXPO_TOKEN_PATTERN, {
    message: 'expoPushToken must be an Expo push token',
  })
  @IsCleanText()
  expoPushToken!: string;
}
