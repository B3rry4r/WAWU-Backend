import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUrl, MaxLength, Min } from 'class-validator';

export class UpsertLearnGuideDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(400) subtitle?: string;
  @IsOptional() @IsIn(['guide', 'playbook', 'export', 'compliance']) kind?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  @IsOptional() @IsInt() @Min(1) readMinutes?: number;
  @IsOptional() @IsISO8601() updated?: string;

  /** Object-storage URL from POST /uploads/presign. */
  @IsOptional()
  @IsUrl({}, { message: 'fileUrl must be a full link' })
  @MaxLength(600)
  fileUrl?: string;
}
