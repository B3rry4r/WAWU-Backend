import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * PUT /users/me/identity (SIGNUP-NAMES, R-82): the name and the username a person is asked for at sign-up, and
 * once more on the next open when an account has none of them. Any part may be left out; a first name and a last
 * name travel together (the name lives in WAWU ID and is saved as a pair), and the username is the profile's handle.
 * The lengths are the ones `PATCH /users/me` takes for the same fields.
 */
export class CompleteIdentityDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  /** The username, with or without a leading "@". Checked by `checkHandleShape`; its words are the server's. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  handle?: string;
}
