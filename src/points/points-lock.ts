import type { Prisma } from '../../generated/prisma/client';

/**
 * One person's points, one call at a time (task POINTS-01): a transaction
 * advisory lock on `points:<wawuUserId>`, released when the transaction ends.
 * Every writer of a person's lots, holds and ledger takes it first: grant,
 * hold, commit, release, the expiry job and the account purge's points step.
 */
export async function lockPersonPoints(
  tx: Prisma.TransactionClient,
  wawuUserId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`points:${wawuUserId}`}, 0))`;
}
