import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as argon2 from 'argon2';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoneyError } from '../money-error';

/**
 * An optional `Idempotency-Key` on the two routes that replace a PIN (task
 * WALLET-06 round 2, D1; docs/contract/CONVENTIONS.md section 4, "On the
 * PIN routes").
 *
 * The problem it closes: a phone sends a PIN change or a reset and gets no
 * answer. Judging by whether the PIN's `changedAt` moved says "done" when
 * someone else changed the PIN, and asking the server with the new PIN spends
 * a wrong-PIN try. With a key the phone just sends the same request again:
 *
 * - it landed: the first answer comes back, `Idempotent-Replayed: true`, and
 *   the PIN is not checked again (the PIN it was sent under is no longer the
 *   PIN), so no try is used;
 * - it never arrived: the repeat is the request, and runs;
 * - it is still running: `409 idempotency_in_progress`, wait and ask again;
 * - someone else changed the PIN meanwhile: the repeat is refused as any
 *   request with a wrong PIN or a dead code is, and says so.
 *
 * Without the header nothing here runs and nothing is stored: the routes
 * answer exactly as before. The same key sent with another body is `409
 * idempotency_key_reused`. A header that is sent but is not 8 to 128 of
 * `[A-Za-z0-9_-]` is `400 idempotency_key_required`: it is refused, not
 * dropped, so a phone never believes it is protected when it is not.
 *
 * How it keeps the answer (the money routes' rules, section 4, applied to a
 * store of its own: the one for payments, MONEY-17's, is on a branch that has
 * not merged):
 * 1. The key row is written `in_progress` FIRST, by the guard that runs after
 *    the wallet gate and BEFORE the PIN guard. The primary key is the lock.
 * 2. The service turns it `done`, with the answer, in the SAME transaction
 *    that changes the PIN (`finishIn`). So `done` means the PIN changed, and
 *    an `in_progress` row older than STALE_CLAIM_SECONDS means it did not
 *    (the request died first) and may be taken again.
 * 3. A refusal, or any failure, before that gives the key back (the filter),
 *    so the same key can be sent again once the cause is fixed (the right PIN
 *    after a wrong one).
 * 4. The fingerprint is an argon2id hash of the body, because the body holds
 *    the new PIN: a fast hash of four digits would hand the PIN to anyone who
 *    can read the table. The answer kept is the PIN's state, never a PIN.
 */

/** Lower case, as Node keys headers. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** The two routes that take a key: the labels stored with it. */
export const PIN_CHANGE_ROUTE = 'PUT /money/pin';
export const PIN_RESET_CONFIRM_ROUTE = 'POST /money/pin/reset/confirm';

/** Seconds the app waits before asking again about a request still running. */
export const PIN_KEY_RETRY_SECONDS = 2;

/**
 * How long a claim may stay `in_progress` before it is taken to be dead.
 * A PIN change is two argon2 hashes and one transaction; a minute is far
 * longer than that, even on a loaded machine. A request that is somehow still
 * running after it cannot finish (`finishIn` checks its own claim), so
 * taking the key over is safe.
 */
export const STALE_CLAIM_SECONDS = 60;

/**
 * Rows older than this go (never sooner than a day, section 4). The app
 * sends a key again only within a few minutes of the first send; the rest
 * is room.
 */
export const PIN_KEY_KEEP_HOURS = 48;

export const KEY_UNUSABLE_MESSAGE =
  'The Idempotency-Key must be 8 to 128 letters, digits, - or _.';
export const KEY_REUSED_MESSAGE =
  'This key was already used for a different request. Start again.';
export const IN_PROGRESS_MESSAGE =
  'This request is still going through. Check again in a moment.';

/** Who sent which key to which route. */
export interface PinRequestKeyId {
  wawuUserId: string;
  route: string;
  key: string;
}

/** The key this request holds. `claimId` is its own claim, never a later one's. */
export interface PinRequestScope extends PinRequestKeyId {
  claimId: string;
}

/** JSON with every object's keys sorted, so the same body is the same text. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/**
 * The wire text of a 200 answer, exactly as ResponseInterceptor writes it:
 * what is stored with the key and what a repeat is sent.
 */
export function okBody(data: unknown): string {
  return JSON.stringify({ statusCode: 200, message: 'OK', data });
}

/**
 * Thrown to answer a repeat with the stored answer. PinRequestKeyFilter
 * writes it exactly as it was first sent.
 */
export class PinRequestReplay extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super('pin request replay');
    this.name = 'PinRequestReplay';
  }
}

/** Prisma's unique-constraint refusal (P2002). */
function isDuplicate(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

function inProgress(): MoneyError {
  return new MoneyError('idempotency_in_progress', IN_PROGRESS_MESSAGE, {
    retryAfterSeconds: PIN_KEY_RETRY_SECONDS,
  });
}

const matchOf = (id: PinRequestKeyId) => ({
  wawuUserId: id.wawuUserId,
  route: id.route,
  key: id.key,
});

@Injectable()
export class PinRequestKeys {
  private readonly logger = new Logger(PinRequestKeys.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Takes the key for this request, or throws what a repeat gets: the stored
   * answer (`PinRequestReplay`), `idempotency_key_reused`, or
   * `idempotency_in_progress`. `body` is the request body as canonical JSON.
   */
  async claim(
    id: PinRequestKeyId,
    body: string,
    now = new Date(),
  ): Promise<PinRequestScope> {
    let fingerprint: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await this.prisma.moneyPinRequestKey.findUnique({
        where: { wawuUserId_route_key: matchOf(id) },
      });
      // Returns only when that row was a dead claim, now deleted.
      if (row) await this.answerExisting(row, id, body, now);
      fingerprint ??= await argon2.hash(body, { type: argon2.argon2id });
      const claimId = randomUUID();
      try {
        await this.prisma.moneyPinRequestKey.create({
          data: { ...matchOf(id), fingerprint, claimId },
        });
        return { ...matchOf(id), claimId };
      } catch (err) {
        // Two first sends at the same moment: the primary key lets one in.
        if (!isDuplicate(err)) throw err;
      }
    }
    throw inProgress();
  }

  private async answerExisting(
    row: Prisma.MoneyPinRequestKeyGetPayload<object>,
    id: PinRequestKeyId,
    body: string,
    now: Date,
  ): Promise<void> {
    const done =
      row.state === 'done' &&
      row.responseStatus !== null &&
      row.responseBody !== null;
    const dead =
      !done &&
      now.getTime() - row.updatedAt.getTime() >= STALE_CLAIM_SECONDS * 1000;
    if (dead) {
      // The request that took it died before it changed anything (the
      // answer is written in the transaction that changes the PIN), so the
      // key is free again. Only that claim is removed.
      await this.prisma.moneyPinRequestKey.deleteMany({
        where: { ...matchOf(id), claimId: row.claimId, state: 'in_progress' },
      });
      return;
    }
    if (!(await argon2.verify(row.fingerprint, body))) {
      throw new MoneyError('idempotency_key_reused', KEY_REUSED_MESSAGE);
    }
    if (done) {
      throw new PinRequestReplay(row.responseStatus!, row.responseBody!);
    }
    throw inProgress();
  }

  /**
   * Stores the answer every repeat gets, INSIDE the transaction that changes
   * the PIN: both happen or neither does. Refuses (and so rolls the change
   * back) when this request no longer holds the key.
   */
  async finishIn(
    tx: Prisma.TransactionClient,
    scope: PinRequestScope,
    status: number,
    body: string,
  ): Promise<void> {
    const { count } = await tx.moneyPinRequestKey.updateMany({
      where: {
        ...matchOf(scope),
        claimId: scope.claimId,
        state: 'in_progress',
      },
      data: { state: 'done', responseStatus: status, responseBody: body },
    });
    if (count !== 1) throw inProgress();
  }

  /** Gives the key back, only while this request's own claim is unfinished. */
  async release(scope: PinRequestScope): Promise<void> {
    await this.prisma.moneyPinRequestKey.deleteMany({
      where: {
        ...matchOf(scope),
        claimId: scope.claimId,
        state: 'in_progress',
      },
    });
  }

  /** Keys older than PIN_KEY_KEEP_HOURS go. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'money-pin-request-key-purge' })
  async purge(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - PIN_KEY_KEEP_HOURS * 3_600_000);
    try {
      const { count } = await this.prisma.moneyPinRequestKey.deleteMany({
        where: { updatedAt: { lt: before } },
      });
      return count;
    } catch (err) {
      this.logger.error(
        `pin request key purge failed: ${err instanceof Error ? err.name : 'error'}`,
      );
      return 0;
    }
  }
}
