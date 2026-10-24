import type { Prisma } from '../../../generated/prisma/client';
import { nextPassPeriod } from './community-pass-rules';

/**
 * THE one place a community pass period is given (shared by the wallet payment,
 * INBOX-24, and the app-store purchase, IAP-01), inside the caller's
 * transaction.
 *
 * Two grants of one person for one room chain, not overlap: the second waits on
 * the lock for the first to commit, then starts from its end. The pass row's
 * `walletPaymentId` is unique, so the same reference grants once: a wallet
 * payment's id, or `store:<store purchase id>` for a store purchase (the column
 * is text with no link to the payments table). The person is made a member (a
 * pending row is a removed member and is never flipped by a grant: the caller
 * refuses first).
 *
 * Returns false when this reference had already granted (nothing was written).
 */
export async function grantPassPeriod(
  tx: Prisma.TransactionClient,
  grant: {
    communityId: string;
    userWawuId: string;
    /** Unique per grant: the wallet payment's id, or `store:<id>`. */
    reference: string;
    priceKobo: bigint;
    days: number;
    now?: Date;
  },
): Promise<boolean> {
  const { communityId, userWawuId } = grant;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`community-pass:${communityId}:${userWawuId}`}))`;
  const latest = await tx.communityPass.aggregate({
    where: { communityId, userWawuId },
    _max: { endsAt: true },
  });
  const now = grant.now ?? new Date();
  const { startsAt, endsAt } = nextPassPeriod(
    now,
    latest._max.endsAt,
    grant.days,
  );
  const { count } = await tx.communityPass.createMany({
    data: [
      {
        communityId,
        userWawuId,
        walletPaymentId: grant.reference,
        startsAt,
        endsAt,
        priceKobo: grant.priceKobo,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return false;
  // The person is in: a new member, or one already in. A pending row is a
  // removed member (the refusal sent that payment back), so the grant never
  // flips one to joined.
  await tx.communityMembership.createMany({
    data: [
      {
        userWawuId,
        communityId,
        status: 'joined',
        joinedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  return true;
}

/** The reference a store purchase's pass row carries. */
export function storePassReference(storePurchaseId: string): string {
  return `store:${storePurchaseId}`;
}

/** True for a pass row a store purchase made. */
export function isStorePassReference(reference: string): boolean {
  return reference.startsWith('store:');
}
