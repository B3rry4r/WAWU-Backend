import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  canonicalJson,
  type IdempotencyScope,
  IdempotencyService,
} from '../payments/idempotency';
import type { PinStateView } from '../money-view.type';
import { pinStateView } from './transaction-pin.service';

/**
 * An optional `Idempotency-Key` on the two routes that replace a PIN (task
 * WALLET-06 round 2, D1; docs/contract/CONVENTIONS.md section 4, "On the
 * PIN routes"), kept in the money routes' own store (`MoneyIdempotencyKey`,
 * MONEY-17, `IdempotencyService`): one row per person, method, route and key.
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
 * The store's rules are the payments' (section 4), with these differences:
 * 1. The key is optional, and the guard that takes it runs after the wallet
 *    gate and BEFORE the PIN guard (pin-request-key.ts).
 * 2. The key row is linked to the person's PIN in the SAME transaction that
 *    changes it (`attach`), so a row that names a resource means the PIN
 *    changed; the answer is stored right after (`finish`). A request that
 *    dies between the two leaves a row that, after STALE_CLAIM_SECONDS, is
 *    answered with the PIN's state as it stands (the registered resolver).
 *    A row that names nothing and is that old is a request that died before
 *    it changed anything: the key is taken again.
 * 3. The fingerprint of the body is argon2id, not SHA-256, because the body
 *    holds the new PIN (and a code): a fast hash of four digits would hand
 *    the PIN to anyone who can read the table. It is salted from the person,
 *    route and key, so the same request always gives the same fingerprint
 *    (the store compares them as text) and no two keys share a salt.
 * 4. The answer kept is the PIN's state, never a PIN or a code.
 */

/** The two routes that take a key: the labels the store keeps (beside the method). */
export const PIN_CHANGE_ROUTE = 'pin:change';
export const PIN_RESET_CONFIRM_ROUTE = 'pin:reset-confirm';

/**
 * How long a claim may stay `in_progress` before it is taken to be dead. A PIN
 * change is two argon2 hashes and one transaction; a minute is far longer than
 * that, even on a loaded machine. A request that is somehow still running
 * after it cannot finish (`attach` checks its own claim), so taking the key
 * over is safe.
 */
export const STALE_CLAIM_SECONDS = 60;

export const KEY_UNUSABLE_MESSAGE =
  'The Idempotency-Key must be 8 to 128 letters, digits, - or _.';

/**
 * The wire text of a 200 answer, exactly as ResponseInterceptor writes it:
 * what is stored with the key and what a repeat is sent.
 */
export function okBody(data: unknown): string {
  return JSON.stringify({ statusCode: 200, message: 'OK', data });
}

/**
 * The fingerprint the store compares a repeat against: argon2id of the body as
 * canonical JSON, with a salt derived from who sent which key to which route.
 * The same request always gives the same text; the PIN in it is not recoverable
 * faster than the PIN's own hash.
 */
export async function pinRequestFingerprint(
  id: { wawuUserId: string; method: string; route: string; key: string },
  body: unknown,
): Promise<string> {
  const salt = createHash('sha256')
    .update(`pin-request:${id.wawuUserId}:${id.method}:${id.route}:${id.key}`)
    .digest()
    .subarray(0, 16);
  return argon2.hash(canonicalJson(body), { type: argon2.argon2id, salt });
}

/** What a service does inside the transaction that changes the PIN. */
export type InPinTransaction = (tx: Prisma.TransactionClient) => Promise<void>;

@Injectable()
export class PinRequestKeys implements OnModuleInit {
  private readonly logger = new Logger(PinRequestKeys.name);

  constructor(
    private readonly keys: IdempotencyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` after the PIN changed (the request died before
    // it stored its answer) is answered with the PIN's state as it stands.
    const answerFromPin = async (row: { resourceId: string | null }) => {
      const pin = row.resourceId
        ? await this.prisma.transactionPin.findUnique({
            where: { wawuUserId: row.resourceId },
          })
        : null;
      return pin
        ? { status: 200, body: okBody(pinStateView(pin, new Date())) }
        : null;
    };
    for (const route of [PIN_CHANGE_ROUTE, PIN_RESET_CONFIRM_ROUTE]) {
      this.keys.onStale(route, STALE_CLAIM_SECONDS * 1000, answerFromPin);
    }
  }

  /**
   * Runs one PIN write under the request's key, when it sent one. `work` gets
   * a step to run inside the transaction that changes the PIN, which links the
   * key to the person's PIN; the answer is stored once it has committed. With
   * no key it is just `work()`.
   */
  async under(
    scope: IdempotencyScope | undefined,
    wawuUserId: string,
    work: (inTransaction?: InPinTransaction) => Promise<PinStateView>,
  ): Promise<PinStateView> {
    if (!scope) return work();
    const view = await work((tx) => this.keys.attach(tx, scope, wawuUserId));
    try {
      await this.keys.finish(scope, 200, okBody(view));
    } catch (err) {
      // The PIN changed, so the answer is true. The row names the PIN, and a
      // repeat is answered from it once the request can no longer be running.
      this.logger.error(
        `pin request key: the answer was not stored (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    return view;
  }
}
