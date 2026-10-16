import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** `POST /money/identity/liveness` (task NUV-03). */
export class StartLivenessDto {
  /**
   * Where the secure selfie page sends the person when it is done: a secure
   * (https) web address, the app's link or the website. Optional.
   */
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  redirectUrl?: string;
}
