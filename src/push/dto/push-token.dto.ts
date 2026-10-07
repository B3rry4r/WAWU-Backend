import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { EXPO_TOKEN_PATTERN } from '../push-config';

/** POST /push-tokens. */
export class RegisterPushTokenDto {
  /** The phone's Expo push token, `ExponentPushToken[...]` or `ExpoPushToken[...]`, exactly as the app got it. */
  @IsString()
  @MaxLength(300)
  @Matches(EXPO_TOKEN_PATTERN, {
    message: 'expoPushToken must be an Expo push token',
  })
  expoPushToken!: string;

  @IsIn(['android', 'ios'])
  platform!: 'android' | 'ios';

  /** The phone's own id, if the app has one. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceId?: string;

  /** A name for the phone ("Pixel 8"), if the app has one. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceLabel?: string;
}

/** DELETE /push-tokens. The token is in the body, never the URL, so it stays out of access logs. */
export class RemovePushTokenDto {
  @IsString()
  @MaxLength(300)
  @Matches(EXPO_TOKEN_PATTERN, {
    message: 'expoPushToken must be an Expo push token',
  })
  expoPushToken!: string;
}
