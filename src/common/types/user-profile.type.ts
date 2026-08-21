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
  xHandle: string | null;
  tiktokHandle: string | null;
  youtubeUrl: string | null;
  facebookUrl: string | null;
  linkedinUrl: string | null;
  tier: 'basic' | 'pro';
  /**
   * The creator's paid-message settings, as a BUYER needs to see them.
   *
   * These were missing from this aggregate, and nothing else exposed another
   * user's DM settings — so the web client had no way to learn any creator's
   * real price and hardcoded `dmEnabled: false, dmPrice: 0`. Every creator on
   * the platform read as "Messages off" to every buyer, which made paid
   * messaging non-functional from the only side that pays for it, however
   * carefully the creator set their rate.
   *
   * `dmPrice` is null when the creator has not set one. A buyer-facing surface
   * must treat "enabled with no price" as closed, never as free.
   */
  dmEnabled: boolean;
  dmPrice: number | null;
  evgScore: number;
  contentCount: number;
  followerCount: number;
  communityCount: number;
}
