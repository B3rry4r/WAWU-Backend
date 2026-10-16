import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { HUB_THROTTLERS } from '../hub-throttlers';

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

/**
 * The most requests of one person that may be waiting, in this process, for
 * their turn at the storage lock (ME-04 round 6). A request that waits for the
 * database's lock holds a pooled connection while it waits, and the pool is
 * shared by every user of the Hub: one person's burst of twenty took all of
 * it and froze everyone else for a minute. So the wait happens here instead,
 * in memory, holding nothing; the request that is let through then takes the
 * database lock with nobody of the same person in front of it.
 *
 * One request runs, up to this many wait behind it, and the rest are refused
 * at once with 429 `storage_busy` and a `Retry-After` (the throttle's own
 * wait). Another Hub process has its own count; the database lock still keeps
 * the processes in order, and each of them holds at most one connection per
 * person.
 */
export const STORAGE_LOCK_WAITERS_PER_PERSON = 2;

/** Seconds a refused request is asked to wait: the throttle's own window (hub-throttlers.ts). */
export const STORAGE_BUSY_RETRY_SECONDS = Math.max(
  1,
  Math.ceil(Math.min(...HUB_THROTTLERS.map((t) => t.ttl)) / 1000),
);

export const STORAGE_BUSY_MESSAGE =
  'You have several uploads in progress. Try again in a moment.';

/**
 * 429 for a person who already has a request running and
 * `STORAGE_LOCK_WAITERS_PER_PERSON` more waiting. The shape every refusal
 * with a reason has: `message` and `reason.code`, with `retryAfterSeconds`
 * (and the same number in a `Retry-After` header, set by
 * `StorageBusyInterceptor`). Nothing was changed.
 */
export class StorageBusyException extends HttpException {
  readonly retryAfterSeconds = STORAGE_BUSY_RETRY_SECONDS;
  constructor() {
    super(
      {
        message: STORAGE_BUSY_MESSAGE,
        reason: {
          code: 'storage_busy',
          retryAfterSeconds: STORAGE_BUSY_RETRY_SECONDS,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

interface PersonLine {
  /** A request of this person holds the turn. */
  busy: boolean;
  /** Requests waiting for it, oldest first. */
  waiting: Array<() => void>;
}

const lines = new Map<string, PersonLine>();

/**
 * Runs `work` (a transaction that takes the person's storage lock) when it is
 * this request's turn among the person's requests in this process. Nothing is
 * held while waiting: no transaction, no connection. `work` must not call
 * this again for the same person (it would wait for itself) and must not call
 * the bucket or the wallet provider.
 *
 * `finishing` is for the second half of a step that already changed something
 * (a release records the result of the delete it asked for): it is never
 * refused, it queues behind the others, because refusing it would leave the
 * first half undone. Only the first half of a step may be refused.
 */
export async function inPersonsTurn<T>(
  wawuId: string,
  work: () => Promise<T>,
  options: { finishing?: boolean } = {},
): Promise<T> {
  let line = lines.get(wawuId);
  if (!line) {
    line = { busy: false, waiting: [] };
    lines.set(wawuId, line);
  }
  if (!line.busy) {
    line.busy = true;
  } else {
    if (
      !options.finishing &&
      line.waiting.length >= STORAGE_LOCK_WAITERS_PER_PERSON
    ) {
      throw new StorageBusyException();
    }
    const mine = line;
    // The turn is handed over by `leave`: `busy` stays true across the hand-over.
    await new Promise<void>((resolve) => mine.waiting.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = line.waiting.shift();
    if (next) next();
    else {
      line.busy = false;
      if (lines.get(wawuId) === line) lines.delete(wawuId);
    }
  }
}

/** How many requests of this person are waiting for their turn in this process (for specs and logs). */
export function requestsWaitingFor(wawuId: string): number {
  return lines.get(wawuId)?.waiting.length ?? 0;
}
