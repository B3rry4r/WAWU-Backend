import type { Prisma } from '../../../generated/prisma/client';

/**
 * The transaction a movement is checked in (task FIX-26, FIX-21 verifier
 * finding F3): the client Prisma hands to an interactive `$transaction`
 * callback, and nothing else.
 *
 * The per-person lock `MoneyLimits` takes is a transaction lock
 * (`pg_advisory_xact_lock`): it is held to the end of the caller's
 * transaction only. Outside one it ends with its own statement, and the
 * movement it was meant to order is not ordered. So the check cannot take
 * "no transaction" or the service's own client, where a root client would
 * read as one:
 *
 * - `Prisma.TransactionClient` is `Omit<PrismaClient, ...>` and a
 *   `PrismaService` is a `PrismaClient`, so on its own it accepts the root
 *   client. Prisma leaves `$connect` and `$disconnect` off the client it
 *   gives a transaction (its deny list, which keeps `$transaction`: Prisma 7
 *   nests transactions) and a root client has both as methods, so requiring
 *   each to be absent (`?: never`) refuses the root client at compile time
 *   and still accepts the `tx` of `prisma.$transaction(async (tx) => ...)`.
 * - What the types cannot refuse (a cast, a JavaScript caller, a second
 *   root client) `assertOwnTransaction` refuses at run time.
 */
export type MovementTx = Prisma.TransactionClient & {
  $connect?: never;
  $disconnect?: never;
};

/**
 * The limit check was given something that is not the caller's own
 * transaction. A programming error in the caller, never a refusal a person
 * can meet: the global filter answers an error that is not an HttpException
 * as a 500 without this text.
 */
export class NotInTransactionError extends Error {
  constructor(readonly reason: 'missing' | 'root_client') {
    super(
      reason === 'missing'
        ? "MoneyLimits.assertMayMove needs the transaction in which the caller writes the movement's pending ledger row (`tx`), and got none: without one the per-person lock orders nothing."
        : "MoneyLimits.assertMayMove needs the transaction in which the caller writes the movement's pending ledger row, and got a client that is not inside one (the service's own client): the per-person lock would end with its own statement. Pass the `tx` of `prisma.$transaction(async (tx) => ...)`.",
    );
    this.name = 'NotInTransactionError';
  }
}

/**
 * Refuses, before anything is locked, read or written, what is not a
 * transaction client: nothing, the service's own client, or any other root
 * Prisma client. Prisma removes `$connect`, `$disconnect`, `$on`, `$use` and
 * `$extends` from the client it gives an interactive transaction, and a root
 * client, an extended one included, always has `$connect`.
 */
export function assertOwnTransaction(tx: unknown, ownClient: unknown): void {
  if (tx === undefined || tx === null) {
    throw new NotInTransactionError('missing');
  }
  if (
    tx === ownClient ||
    typeof (tx as { $connect?: unknown }).$connect === 'function'
  ) {
    throw new NotInTransactionError('root_client');
  }
}
