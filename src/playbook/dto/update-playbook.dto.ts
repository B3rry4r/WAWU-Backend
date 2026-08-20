import { IsInt, IsOptional, IsString, IsUrl, MaxLength, Min } from 'class-validator';

/** Every field optional: an operator may be replacing only the file. */
export class UpdatePlaybookDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() @Min(1) pages?: number;
  @IsOptional() @IsString() @MaxLength(40) format?: string;

  /** Object-storage URL from POST /uploads/presign. */
  @IsOptional()
  @IsUrl({}, { message: 'fileUrl must be a full link' })
  @MaxLength(600)
  fileUrl?: string;
}
