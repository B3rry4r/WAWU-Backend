import type { Prisma } from '../../generated/prisma/client';

/**
 * One referrer's rewards, one settlement at a time: a transaction advisory
 * lock on `referral:<wawuUserId>`, released when the transaction ends. A
 * reward is settled and the milestones are counted under it, so two rewards
 * of one person that come due together cannot both miss the milestone they
 * reach between them. It is taken before the points lock, never after.
 */
export async function lockReferrer(
  tx: Prisma.TransactionClient,
  wawuUserId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`referral:${wawuUserId}`}, 0))`;
}

/**
 * Two people's claims on each other, one at a time: a lock on the pair, so
 * "A uses B's code" and "B uses A's code" at the same moment cannot both pass
 * the check that the code's owner was not invited by the caller.
 */
export async function lockPair(
  tx: Prisma.TransactionClient,
  a: string,
  b: string,
): Promise<void> {
  const [first, second] = a < b ? [a, b] : [b, a];
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`referral-pair:${first}:${second}`}, 0))`;
}
