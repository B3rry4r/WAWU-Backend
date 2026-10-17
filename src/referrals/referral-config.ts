/**
 * Referral points: the limits of the code, not the figures (task REF-02).
 * Every figure a person is paid or told (the multipliers, the milestones, the
 * hold days, the claim days, the base points) is an admin setting
 * (`referral.*`, TIER-06, R-65) read from the live plan. These are only how
 * the code looks and how much one pass of the job does.
 */
export const REFERRAL_CODE = {
  /** Letters and digits the code is made of, matched in upper case. */
  minLength: 3,
  maxLength: 20,
  /** Longest name-based code; the rest of the room is for a suffix. */
  nameLength: 10,
  /** Tries at a free code before a random one is used. */
  nameAttempts: 5,
  /** Characters of a random code (no 0, 1, I, O: they are misread). */
  randomLength: 8,
  alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
} as const;

/** The link a person shares is `wawu/r/<code>` (lower case, R-68 names no outside host). */
export const REFERRAL_LINK_PREFIX = 'wawu/r/';

export const REFERRAL_VIEW = {
  /** The newest rewards listed on `GET /me/referrals` (RF1, RF3). */
  rewards: 20,
} as const;

export const REFERRAL_SWEEP = {
  /**
   * Rewards one pass of the job settles, soonest due first; the rest wait for
   * the next pass.
   * PROVISIONAL(REF-SWEEP-BATCH, owner=YOU, why=no ruling names how many rewards one pass settles; 50 keeps a pass short)
   */
  batch: 50,
  /** Referrals one pass looks at for a paid tier its hook missed. */
  reconcileBatch: 100,
} as const;
