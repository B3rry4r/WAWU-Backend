import type {
  PlanReferralLevel,
  PlanReferralMilestone,
} from '../plans/plans-config';

/** A multiplier is kept in thousandths: 1.25 is 1250 (the database holds it that way). */
export const MILLI = 1000;

export function toMilli(x: number): number {
  return Math.round(x * MILLI);
}

/**
 * The multiplier for a person with `verified` verified referrals: the x of
 * the highest level whose `min` they have reached, and x1 before the first.
 * `levels` is ordered by `min`, as the setting is checked to be.
 */
export function multiplierMilliFor(
  levels: readonly PlanReferralLevel[],
  verified: number,
): number {
  let milli = MILLI;
  for (const l of levels) if (verified >= l.min) milli = toMilli(l.x);
  return milli;
}

/** How many levels the person has reached (0 before the first). */
export function levelsReached(
  levels: readonly PlanReferralLevel[],
  verified: number,
): number {
  return levels.filter((l) => verified >= l.min).length;
}

/** Whole points: the base times the multiplier, half up (the database's CHECK says the same). */
export function rewardPoints(
  basePoints: number,
  multiplierMilli: number,
): number {
  return Math.floor((basePoints * multiplierMilli + MILLI / 2) / MILLI);
}

/** The first milestone above `verified`, or null when every one is reached. */
export function nextMilestone(
  milestones: readonly PlanReferralMilestone[],
  verified: number,
): PlanReferralMilestone | null {
  let next: PlanReferralMilestone | null = null;
  for (const m of milestones)
    if (m.count > verified && (next === null || m.count < next.count)) next = m;
  return next;
}
