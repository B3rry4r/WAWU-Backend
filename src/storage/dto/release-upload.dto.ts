import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /uploads/release (ME-04 round 2): the key `POST /uploads/presign`
 * answered with for a file the person has taken out of a draft.
 */
export class ReleaseUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  key: string;
}
