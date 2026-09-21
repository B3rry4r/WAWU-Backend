import type { CreatorStateModel } from '../../../generated/prisma/models';

export type CreatorState = CreatorStateModel;

/**
 * GET /creator/state wire response. `slotsTotal` (registry note: "derived")
 * is NOT a CreatorState column. It is the flat per-account cap from
 * creator-allowance.ts, computed by the service layer and never stored. It
 * used to derive from `tier`; there is no tier any more, so it is now the
 * same number for every creator.
 */
export type CreatorStateResponse = CreatorState & {
  slotsTotal: number;
};
