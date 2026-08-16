import { IsIn, IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator';

/**
 * registry.json "KycSubmission".idDocumentType — mirrored from
 * fragments/kyc.json's observed literal set ("passport"|"national_id_card"|
 * "drivers_licence"). Not a Prisma enum (schema stores idDocumentType as a
 * plain String — prisma/schema.prisma is frozen and already made that
 * choice), so this is the DTO-side validation of the fixed set.
 */
export const ID_DOCUMENT_TYPE_VALUES = ['passport', 'national_id_card', 'drivers_licence'] as const;
export type IdDocumentTypeValue = (typeof ID_DOCUMENT_TYPE_VALUES)[number];

function isNigeria(country: string | undefined): boolean {
  return country?.trim().toLowerCase() === 'nigeria';
}

/**
 * POST /kyc body per registry.json. Country-conditional identity fields per
 * the registry note: "Nigeria requires bvn+nin; elsewhere
 * nationalIdEquivalent. Server validates by country per product-truths.json."
 * BVN/NIN are validated as 11-digit strings — Nigeria's standard identifier
 * length, and what both seeded KycSubmission rows in prisma/seed.ts use.
 */
export class CreateKycSubmissionDto {
  @IsString()
  @IsNotEmpty()
  country!: string;

  @ValidateIf((o: CreateKycSubmissionDto) => isNigeria(o.country))
  @IsString()
  @Matches(/^\d{11}$/, { message: 'bvn must be an 11-digit number' })
  bvn?: string;

  @ValidateIf((o: CreateKycSubmissionDto) => isNigeria(o.country))
  @IsString()
  @Matches(/^\d{11}$/, { message: 'nin must be an 11-digit number' })
  nin?: string;

  @ValidateIf((o: CreateKycSubmissionDto) => !isNigeria(o.country))
  @IsString()
  @IsNotEmpty()
  nationalIdEquivalent?: string;

  @IsIn(ID_DOCUMENT_TYPE_VALUES)
  idDocumentType!: IdDocumentTypeValue;

  @IsString()
  @IsNotEmpty()
  idDocumentUrl!: string;

  @IsString()
  @IsNotEmpty()
  payoutBankName!: string;

  @IsString()
  @IsNotEmpty()
  payoutAccountNumber!: string;
}
