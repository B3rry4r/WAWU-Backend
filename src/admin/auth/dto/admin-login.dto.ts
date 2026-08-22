import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * POST /admin/auth/login body.
 *
 * The global ValidationPipe runs with `whitelist: true` and
 * `forbidNonWhitelisted: true` (src/main.ts), so an unknown property is a 400
 * here exactly as it is on every app-facing DTO.
 */
export class AdminLoginDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(320)
  email!: string;

  /**
   * Capped because argon2 hashes whatever it is given: an unbounded password
   * field is a cheap way to make the server do expensive work.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password!: string;
}
