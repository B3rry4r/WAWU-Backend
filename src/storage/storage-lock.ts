import type { Prisma } from '../../generated/prisma/client';

/**
 * The one lock every step that decides what happens to a person's upload rows
 * takes (ME-04 round 4): a confirm that counts a file, a release that gives it
 * up, a listing that names it, and the sweep that removes it. Taken on the
 * person, inside the caller's own transaction, and held to its end
 * (`pg_advisory_xact_lock`), so two of them for the same person run one after
 * the other and the later one reads what the earlier one wrote. Different
 * people never wait on each other.
 */
export async function lockStorageQuota(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  wawuId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`storage-quota:${wawuId}`}, 0))`;
}

/**
 * Interactive transactions that hold the lock across a call to the bucket (a
 * release, a sweep removal) outlive Prisma's 5 second default, and may wait a
 * while for the person's earlier step to finish.
 */
export const LOCKED_TX = { maxWait: 15_000, timeout: 60_000 } as const;
