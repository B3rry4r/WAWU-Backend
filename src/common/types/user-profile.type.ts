import type { UserProfileModel } from '../../../generated/prisma/models';
import type { WawuJwtClaims } from '../auth/wawu-jwt-claims.interface';
import type { VerificationState } from '../verification/verification-state';
import type { ProfileExperienceView } from '../../user-profile/profile-experience.type';

export type UserProfile = UserProfileModel;

/**
 * The four stored verification dates, which never go on the wire.
 *
 * `UserProfileWithClaims` is a spread of the whole Prisma row, so anything
 * added to the model lands on GET /users/me by default (protected-surface
 * hazard H-1). The ticks are published as a derived `verification` object and
 * the raw dates are omitted here, so no client can start comparing the dates
 * itself and drawing its own tick.
 */
type StoredVerificationDates =
  | 'creatorVerifiedAt'
  | 'creatorVerifiedUntil'
  | 'professionalVerifiedAt'
  | 'professionalVerifiedUntil';

/** GET /users/me response.shape: "UserProfile & WawuJwtClaims (merged)". */
export type UserProfileWithClaims = Omit<UserProfile, StoredVerificationDates> &
  WawuJwtClaims & {
    /** Both ticks, derived server-side. See deriveVerificationState. */
    verification: VerificationState;
    /**
     * The owner's own roles, newest first.
     *
     * It rides on the profile rather than sitting behind its own GET: the
     * header renders it on first paint, and a caller with no profile row yet
     * gets an empty array rather than a query.
     */
    experience: ProfileExperienceView[];
  };

/**
 * GET /users/:wawuId/public-profile response.shape: "CreatorProfile" — a
 * derived aggregate, not its own table. Merges UserProfile + CreatorState +
 * EvgScore + content/community/product summaries (registry.json note).
 */
export interface CreatorProfile {
  wawuUserId: string;
  /**
   * Both ticks, as every user-shaped response on this backend carries them.
   *
   * Derived server-side from the expiry. A client never compares dates to
   * decide whether to draw a tick, and both ticks render when both are held.
   */
  verification: VerificationState;
  handle: string | null;
  bio: string | null;
  /**
   * The profile picture and the cover, as ANYBODY looking at this creator
   * needs them.
   *
   * They were missing from this aggregate while being present on the profile
   * row and on GET /users/me, so uploading a picture worked, saving it worked,
   * and the owner could see it on their own screen. Everyone ELSE got null,
   * because this is the only endpoint that serves somebody else's profile.
   * The web client already reads `avatarUrl` off this response and falls back
   * to initials, so the failure was silent: no error, just a platform where
   * nobody's photograph ever appeared to anybody.
   */
  avatarUrl: string | null;
  coverUrl: string | null;
  interests: string[];
  instagramHandle: string | null;
  whatsappHandle: string | null;
  websiteUrl: string | null;
  /**
   * The one line under the name, as the approved header draws it. A person's
   * own sentence about what they do, never their first interest category.
   */
  headline: string | null;
  /**
   * The organisation this person is part of, as the approved profile header
   * draws it beside the location and the website. Free text: see the schema's
   * note on why it is not a relation.
   */
  company: string | null;
  /**
   * The experience list, newest first, with the role they hold now at the
   * top. Public, because it is the part of a profile that says who somebody
   * is; the private figures on that screen stay on the owner-only stats
   * endpoint.
   */
  experience: ProfileExperienceView[];
  xHandle: string | null;
  tiktokHandle: string | null;
  youtubeUrl: string | null;
  facebookUrl: string | null;
  linkedinUrl: string | null;
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
  /**
   * Hours the creator has to reply before the payer is automatically
   * refunded. Buyer-facing because it is a term of the sale: the reply
   * window is the promise the money is being exchanged for, and it is no
   * longer a fixed 24 across the platform, so the buyer cannot assume it.
   */
  dmResponseHours: number;
  evgScore: number;
  contentCount: number;
  followerCount: number;
  /**
   * How many accounts THIS person follows — the middle figure in the
   * profile's three-up stat row, beside followers and posts.
   *
   * Counted from FollowRelationship, the same relation `followerCount` is
   * counted from and in the other direction. No column: a follow and an
   * unfollow would both have to remember to move it, and the day one forgets
   * is the day the number is wrong for good.
   *
   * Public, like the follower count. The private figures on that screen
   * (profile views, sales) are deliberately NOT here — they live on the
   * owner-only GET /users/me/profile-stats.
   */
  followingCount: number;
  communityCount: number;
}
