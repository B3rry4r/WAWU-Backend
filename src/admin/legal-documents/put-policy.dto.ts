import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsCleanText, IsRealDate, WithinPolicySize } from './policy-input';

export class PolicySectionDto {
  @IsString()
  @IsCleanText()
  @MaxLength(200)
  heading!: string;

  @IsString()
  @IsCleanText()
  @MaxLength(20000)
  body!: string;
}

export class PutPolicyDto {
  @IsString()
  @IsCleanText()
  @MaxLength(120)
  title!: string;

  /** The date the owner gives the text, YYYY-MM-DD. */
  @IsRealDate()
  effectiveDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @WithinPolicySize()
  @ValidateNested({ each: true })
  @Type(() => PolicySectionDto)
  sections!: PolicySectionDto[];
}
