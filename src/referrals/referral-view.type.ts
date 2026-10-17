/**
 * What the referral routes answer (task REF-02, RF1 to RF4). Every figure is
 * a count of points or of people: never naira, and nothing here converts one
 * into the other. Referral pays points, never cash (R-43).
 */

/** Where a reward is: held, in the person's points, or never to be. */
export type ReferralRewardStateName = 'pending' | 'available' | 'cancelled';

/** One rung of the level ladder (RF1, RF4). */
export interface ReferralLadderStepView {
  /** Verified referrals needed to reach the level. */
  verified: number;
  /** The multiplier on the base points, for example 1.25. */
  multiplier: number;
  /** The person has reached this level. */
  reached: boolean;
}

/** One milestone (RF1, RF3a). */
export interface ReferralMilestoneView {
  /** Verified referrals it is for. */
  verified: number;
  /** Bonus points, granted once. */
  points: number;
  reached: boolean;
  /** When the points were granted (ISO 8601, UTC); null before. */
  grantedAt: string | null;
}

/** The next milestone not yet reached (RF1: "Next: +500 points at 5 verified"). */
export interface ReferralNextMilestoneView {
  verified: number;
  points: number;
  /** How many more verified referrals it needs. */
  remaining: number;
}

/** One reward for one invited person's first paid tier (RF3). */
export interface ReferralRewardView {
  id: string;
  /** The invited person's name as WAWU ID gives it, else their handle, else ''. */
  name: string;
  tierId: string;
  /** The tier's name in the plan ("Verify"). */
  tierName: string;
  /** Points before the multiplier. */
  basePoints: number;
  /** The multiplier the reward was made with, for example 1.25. */
  multiplier: number;
  /** Base points times the multiplier, whole. */
  points: number;
  /** `pending` through the hold, `available` once the points are the person's. */
  state: ReferralRewardStateName;
  /** When the hold ends (ISO 8601, UTC). */
  availableAt: string;
  /** When it became available or was cancelled (ISO 8601, UTC); null while pending. */
  settledAt: string | null;
}

export interface MyReferralsView {
  /** The link to share: `wawu/r/<code>` in lower case. */
  link: string;
  /** The person's own code, upper case. */
  code: string;
  /** People who used the code. */
  brought: number;
  /** People whose reward is available: paid for a tier, verified, past the hold. */
  verified: number;
  /** Rewards still in the hold. */
  pending: number;
  /** Points earned: available rewards and milestones. Not the balance. */
  pointsEarned: number;
  /** Points in the hold, not yet the person's. */
  pendingPoints: number;
  /** The multiplier a new reward earns now (x1 before the first level). */
  multiplier: number;
  /** Levels reached, 0 before the first. */
  level: number;
  /** Every level, lowest first. */
  ladder: ReferralLadderStepView[];
  /** The next milestone, or null when every one is reached. */
  nextMilestone: ReferralNextMilestoneView | null;
  /** Every milestone, lowest first. */
  milestones: ReferralMilestoneView[];
  /** Days a reward is held (RF4). */
  holdDays: number;
  /** Days after sign-up in which a code can be used. */
  claimDays: number;
  /** The newest rewards, newest first. */
  rewards: ReferralRewardView[];
}

/** What a claim answers. */
export interface ClaimReferralView {
  /** The code, upper case. */
  code: string;
  /** When it was claimed (ISO 8601, UTC). */
  claimedAt: string;
}
