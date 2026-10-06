import type { CreatorStateModel } from '../../../generated/prisma/models';

export type CreatorState = CreatorStateModel;

/**
 * GET /creator/state wire response. `slotsTotal` (registry note: "derived")
 * is NOT a CreatorState column. It is the per-account cap from
 * creator-allowance.ts, computed by the service layer from the creator's tick
 * (R-7: 5, or 25 with a tick) and never stored.
 */
export type CreatorStateResponse = CreatorState & {
  slotsTotal: number;
};
