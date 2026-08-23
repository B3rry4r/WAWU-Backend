import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ProfessionalCredentialKind } from '../../../generated/prisma/enums';
import { PROFESSIONAL_CATEGORIES } from '../professional-categories';

/**
 * POST /professionals/applications.
 *
 * The regulated-category rules (a licence kind, a licence number and an
 * issuing body) are NOT expressed here as decorators, because they depend on
 * another field's value and a class-validator conditional would state the
 * rule in a place a reviewer never reads. They are enforced in the service,
 * next to the comment explaining why they exist.
 */
export class ApplyProfessionalDto {
  @IsIn(PROFESSIONAL_CATEGORIES)
  category!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  headline!: string;

  @IsString()
  @MinLength(40)
  @MaxLength(2000)
  about!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  services?: string[];

  @IsIn(Object.values(ProfessionalCredentialKind))
  credentialKind!: ProfessionalCredentialKind;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  licenceNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  issuingBody?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  documents?: string[];
}
