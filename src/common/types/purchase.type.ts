import type { PurchaseModel } from '../../../generated/prisma/models';

export type Purchase = PurchaseModel;

/**
 * Wire response for Purchase — `commissionRate` is a Prisma `Decimal`
 * (snapshotted 0.15 / 0.10 at transaction time, conventions.md § Identity &
 * format canon). Decimal serializes to a JSON number on the wire; this type
 * documents that shape explicitly since `Decimal` itself is not JSON-native.
 */
export type PurchaseResponse = Omit<Purchase, 'commissionRate'> & {
  commissionRate: number;
};
