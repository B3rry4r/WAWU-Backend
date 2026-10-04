import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PolicySectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  heading!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  body!: string;
}

export class PutPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  /** The date the owner gives the text, YYYY-MM-DD. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveDate must be YYYY-MM-DD',
  })
  effectiveDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PolicySectionDto)
  sections!: PolicySectionDto[];
}
