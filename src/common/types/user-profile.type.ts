import type { UserProfileModel } from '../../../generated/prisma/models';
import type { WawuJwtClaims } from '../auth/wawu-jwt-claims.interface';

export type UserProfile = UserProfileModel;

/** GET /users/me response.shape: "UserProfile & WawuJwtClaims (merged)". */
export type UserProfileWithClaims = UserProfile & WawuJwtClaims;

/**
 * GET /users/:wawuId/public-profile response.shape: "CreatorProfile" — a
 * derived aggregate, not its own table. Merges UserProfile + CreatorState +
 * EvgScore + content/community/product summaries (registry.json note).
 */
export interface CreatorProfile {
  wawuUserId: string;
  handle: string | null;
  bio: string | null;
  interests: string[];
  instagramHandle: string | null;
  whatsappHandle: string | null;
  websiteUrl: string | null;
  tier: 'basic' | 'pro';
  evgScore: number;
  contentCount: number;
  followerCount: number;
  communityCount: number;
}
