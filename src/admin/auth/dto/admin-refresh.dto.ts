import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /admin/auth/refresh body. */
export class AdminRefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  refreshToken!: string;
}
