import type {
  PointLotSourceName,
  PointMovementReason,
} from './points-view.type';

/**
 * The plain words PT5 shows for a lot and for each movement (task POINTS-01).
 * One table, so every screen that shows points says the same thing. No
 * em-dashes, and never a naira or dollar figure: points are a count.
 */
export const POINT_LOT_LABELS: Record<PointLotSourceName, string> = {
  tier_bonus: 'Tier bonus',
  pack: 'Bought points',
  bump: 'Added at checkout',
  referral: 'Referral reward',
  shortfall: 'Topped up from your wallet',
  returned: 'Points given back',
};

/** The words for an AI tool's hold when the calling task gave no title. */
const AN_AI_TOOL = 'an AI tool';

type HoldPurposeName = 'ai_job' | 'cash_out';
type HoldStateName = 'held' | 'committed' | 'released';

/** What a ledger row's label is built from. */
export interface PointMovementFacts {
  reason: PointMovementReason;
  lotSource: PointLotSourceName;
  hold: {
    purpose: HoldPurposeName;
    state: HoldStateName;
    title: string | null;
  } | null;
}

/**
 * A grant says where the points came from; a hold says what they paid for
 * ("Spent on VoiceOver" once committed, "Held for VoiceOver" while the job
 * runs or after it was given back); a release says they came back; an expiry
 * says they ended.
 */
export function pointMovementLabel(facts: PointMovementFacts): string {
  switch (facts.reason) {
    case 'grant':
      return POINT_LOT_LABELS[facts.lotSource];
    case 'expire':
      return 'Expired';
    case 'hold':
    case 'release': {
      const hold = facts.hold;
      if (hold?.purpose === 'cash_out') {
        if (facts.reason === 'release') return 'Conversion cancelled';
        return hold.state === 'committed'
          ? 'Converted to cash'
          : 'Converting to cash';
      }
      const what = hold?.title ?? AN_AI_TOOL;
      if (facts.reason === 'release') return `Returned from ${what}`;
      return hold?.state === 'committed'
        ? `Spent on ${what}`
        : `Held for ${what}`;
    }
  }
}
