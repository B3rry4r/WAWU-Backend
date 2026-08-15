/**
 * Shape of a verified WAWU ID access-token payload. Confirmed against the
 * real WAWU ID service's token.service.ts (see conventions.md § Auth model).
 * This backend NEVER stores these fields as its own source of truth for
 * identity — every resource keys on `sub` (wawuUserId) only.
 */
export interface WawuJwtClaims {
  sub: string;
  email: string | null;
  phone: string;
  firstName: string;
  lastName: string;
  country: string;
  verificationTier: string;
  trustScore: number | null;
  status: string;
  platformRefs?: {
    wawuafricaAppUserId?: string;
    onboardingRef?: string;
    beautyUserId?: string;
    basketUserId?: string;
  };
  iat: number;
  exp: number;
}
