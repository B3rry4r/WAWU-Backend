import type { VerificationSubmissionModel } from '../../../generated/prisma/models';

export type VerificationSubmission = VerificationSubmissionModel;

/**
 * GET /verification/ladder response.shape: "VerificationLevelEntry[]
 * (derived: JWT verificationTier + submission history)". Not its own table —
 * combines the WAWU-ID-owned `verificationTier` JWT claim with this
 * backend's VerificationSubmission history.
 */
export interface VerificationLevelEntry {
  tier:
    | 'basic'
    | 'verified_user'
    | 'verified_business'
    | 'certified_professional'
    | 'trusted_partner';
  achieved: boolean;
  currentTier: boolean;
  submission: VerificationSubmission | null;
}
