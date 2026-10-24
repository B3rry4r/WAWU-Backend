import { IsString, MaxLength } from 'class-validator';

/**
 * PUT /users/me/handle (SIGNUP-NAMES round 3, M2): the app's Edit profile changing the username (the profile's
 * handle). It takes the rules of `PUT /users/me/identity` (`checkHandleShape`, case-blind uniqueness, the same
 * lock); `PATCH /users/me` keeps its old handle rules because the web calls it. The value is required here: this
 * route does not clear a username.
 */
export class ChangeHandleDto {
  /** The username, with or without a leading "@". Checked by `checkHandleShape`; its words are the server's. */
  @IsString()
  @MaxLength(60)
  handle!: string;
}
