import { ArrayNotEmpty, IsArray, IsIn, IsString } from 'class-validator';

/**
 * registry.json "VerificationSubmission".tier enum, mirrored from
 * prisma/schema.prisma's VerificationTier (schema is frozen — this is the
 * DTO-side copy of the same fixed set of values, not a redeclaration of the
 * model itself).
 */
export const VERIFICATION_TIER_VALUES = [
  'basic',
  'verified_user',
  'verified_business',
  'certified_professional',
  'trusted_partner',
] as const;

export type VerificationTierValue = (typeof VERIFICATION_TIER_VALUES)[number];

/** POST /verification/submissions body per registry.json. */
export class CreateVerificationSubmissionDto {
  @IsIn(VERIFICATION_TIER_VALUES)
  tier!: VerificationTierValue;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  documents!: string[];
}
