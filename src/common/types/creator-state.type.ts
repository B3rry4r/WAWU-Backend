import type { CreatorStateModel } from '../../../generated/prisma/models';

export type CreatorState = CreatorStateModel;

/**
 * GET /creator/state wire response. `slotsTotal` (registry note: "derived")
 * is NOT a CreatorState column — it derives from `tier` and is computed by
 * the service layer, never stored (per the schema agent's own worked example).
 */
export type CreatorStateResponse = CreatorState & {
  slotsTotal: number;
};
