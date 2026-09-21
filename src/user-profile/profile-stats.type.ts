import type { ProfileStep } from './profile-completeness';

/**
 * GET /users/me/profile-stats — the numbers on your OWN profile screen.
 *
 * ── WHY THIS IS A SEPARATE, OWNER-ONLY ENDPOINT ────────────────────────────
 * Three of these figures are nobody else's business. How many people looked
 * at you, and how much you sold this month, are facts about your account, not
 * facts about your public profile, and hanging them off
 * `GET /users/:wawuId/public-profile` would publish them to every visitor the
 * moment they were added. The follower / following / post counts ARE public
 * and stay on that aggregate as well; they are repeated here so the screen
 * can fill its whole header from one call.
 *
 * Every number is DERIVED on read. Nothing here is a counter column, so
 * nothing here can drift from the rows it describes.
 */
export interface ProfileStatsView {
  wawuUserId: string;

  /** The three-up row under the bio. Counted from FollowRelationship and ContentPiece. */
  followerCount: number;
  followingCount: number;
  /** Live content pieces — what the screen labels "Posts". */
  postCount: number;

  /**
   * The stat cards, both scoped to THIS calendar month (UTC), which is what
   * the card's own "This month" line claims.
   */
  profileViewsThisMonth: number;
  productsSoldThisMonth: number;
  /** The first day of the window these two are counted over, so the client need not guess it. */
  monthStart: Date;

  /** The "Complete your profile" ring, and what is still outstanding. */
  profileCompletenessPct: number;
  profileCompletenessMissing: ProfileStep[];
}
