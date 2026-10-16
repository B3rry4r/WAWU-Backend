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

/**
 * Nothing that holds the person's lock, a transaction or a pooled connection
 * calls the bucket (ME-04 round 5). A step that has to delete a file works in
 * three parts instead: under the lock, a short transaction re-reads the row,
 * checks that no listing uses the key, and marks the row `removingAt` (a row
 * being removed is also released and `abandoned`, which every listing, frame
 * and confirm already refuses); then, holding nothing, it asks the bucket to
 * delete; then, under the lock again, a short transaction records the result
 * or puts the row back.
 *
 * A mark older than this belongs to a removal that never finished (the Hub
 * stopped between the parts). The sweep takes such a row over; a younger mark
 * is another step's removal in flight, and is left alone. Long against the
 * bucket's own request timeout (storage.service.ts), which bounds the
 * delete.
 */
export const REMOVING_STALE_MS = 2 * 60 * 1000;

/** Whether `removingAt` marks a removal that is still in flight at `now`. */
export function removalInFlight(
  row: { removingAt: Date | null },
  now: number = Date.now(),
): boolean {
  return (
    row.removingAt !== null &&
    now - row.removingAt.getTime() < REMOVING_STALE_MS
  );
}
