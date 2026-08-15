import type { CreatorNoResponseTrackerModel } from '../../../generated/prisma/models';

export type CreatorNoResponseTracker = CreatorNoResponseTrackerModel;

/**
 * `noResponseRatePct` is a Prisma `Decimal` — serializes to a JSON number on
 * the wire.
 */
export type CreatorNoResponseTrackerResponse = Omit<
  CreatorNoResponseTracker,
  'noResponseRatePct'
> & {
  noResponseRatePct: number;
};
