import type { CreatorSubscriptionModel } from '../../../generated/prisma/models';

export type CreatorSubscription = CreatorSubscriptionModel;

/**
 * `commissionRateOverride` is a Prisma `Decimal` (nullable) — serializes to
 * a JSON number/null on the wire.
 */
export type CreatorSubscriptionResponse = Omit<
  CreatorSubscription,
  'commissionRateOverride'
> & {
  commissionRateOverride: number | null;
};
