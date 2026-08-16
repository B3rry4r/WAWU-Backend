import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/** POST /verification/submissions/:id/resubmit body per registry.json. */
export class ResubmitVerificationSubmissionDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  documents!: string[];
}
