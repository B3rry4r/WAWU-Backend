import type { Prisma } from '../../../generated/prisma/client';

/**
 * The per-person lock every write that touches both a person's PIN and their
 * PIN resets takes FIRST in its transaction (WALLET-06 round 2, D2):
 *
 * - `PinResetService.start()` (a new reset, which ends the older ones),
 * - `TransactionPinService.change()` (a new PIN, which ends every open reset),
 * - `PinResetService.confirm()`'s final transaction (a code used, a new PIN).
 *
 * Before this, `change` took the PIN row and then the reset rows while
 * `confirm` took the reset row and then the PIN row, so one of each at the
 * same moment could deadlock and one answered 500. With the same lock first
 * they run one after the other, and the second finds what the first left.
 *
 * A transaction-scoped advisory lock: held until the transaction ends, so it
 * is never left behind. The key is the one `start()` has always used.
 * `pg_advisory_xact_lock` returns void, which Prisma cannot read back, so it
 * is selected `FROM` and an ordinary column read.
 */
export async function lockPinPerson(
  tx: Prisma.TransactionClient,
  wawuUserId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${`pin-reset:${wawuUserId}`}, 0))`;
}
