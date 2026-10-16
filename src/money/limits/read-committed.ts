import type { Prisma } from '../../../generated/prisma/client';

/**
 * The isolation level `MoneyLimits.assertMayMove` needs in the caller's
 * transaction (task FIX-21; mobile repo BACKEND_GAPS G-410): READ COMMITTED,
 * Postgres's default and what Prisma's `$transaction` runs at when it is
 * given no `isolationLevel`.
 *
 * Why only this one: the per-person advisory lock orders two movements only
 * if each read after the lock sees what committed before that read began,
 * and that is READ COMMITTED. Under REPEATABLE READ every read sees the
 * snapshot taken at the transaction's first statement, before the lock was
 * granted, so two movements of 600 against a daily limit of 1000 both pass;
 * under SERIALIZABLE one of them fails with a write conflict instead of
 * `limit_reached`. READ UNCOMMITTED behaves as READ COMMITTED in Postgres,
 * but no caller asks for it, so it is refused with the rest.
 */
export const REQUIRED_ISOLATION_LEVEL = 'read committed';

/**
 * The limit check ran in a transaction at another isolation level. A
 * programming error in the caller, never a refusal a person can meet: every
 * caller leaves the level at the default, and the global filter answers an
 * error that is not an HttpException as a 500 without this text.
 */
export class IsolationLevelError extends Error {
  constructor(readonly level: string) {
    super(
      `MoneyLimits.assertMayMove must run in a READ COMMITTED transaction (Prisma's default), and this one runs at "${level}", where the per-person lock does not order two movements. Leave isolationLevel unset on the caller's $transaction.`,
    );
    this.name = 'IsolationLevelError';
  }
}

/**
 * Reads the level of the caller's transaction itself (`transaction_isolation`,
 * inside `tx`), so a level set through Prisma's option, by `SET TRANSACTION`
 * or by the database's default is seen alike, and refuses any level but
 * READ COMMITTED with an IsolationLevelError naming it.
 */
export async function assertReadCommitted(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const rows = await tx.$queryRaw<
    Array<{ level: string }>
  >`SELECT current_setting('transaction_isolation') AS level`;
  const level = rows[0]?.level ?? 'unknown';
  if (level !== REQUIRED_ISOLATION_LEVEL) throw new IsolationLevelError(level);
}
