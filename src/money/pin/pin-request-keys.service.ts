import { createHash, createHmac } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  canonicalJson,
  IN_PROGRESS_RETRY_SECONDS,
  type IdempotencyScope,
  IdempotencyService,
} from '../payments/idempotency';
import { MoneyError } from '../money-error';
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
 *   request with a wrong PIN or a code that no longer works is, and says so.
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
 * 3. The fingerprint of the body is an HMAC-SHA256 under a key only this
 *    server holds, not the payments' plain SHA-256, because the body holds the
 *    new PIN (and a code): a plain hash of four digits would hand the PIN to
 *    anyone who can read the table, and so would a salted one (round 2 used
 *    argon2id salted from values in the row; N3). The key is derived from
 *    WAWU_ID_INTERNAL_SERVICE_KEY, a secret the Hub already refuses to start
 *    without in production, with the fixed label FINGERPRINT_LABEL. The
 *    person, route and key are in the HMAC's input, so the same request
 *    always gives the same fingerprint (the store compares them as text) and
 *    no two keys share one. Rows written before round 3 hold the argon2id
 *    form and are read as before until they expire (`PinRequestKeys.claim`).
 * 4. The answer kept is the PIN's state, never a PIN or a code.
 * 5. A row that names the PIN and has no answer after STALE_CLAIM_SECONDS is
 *    answered with the PIN's state only if the PIN is still the one the
 *    repeated request carries; otherwise `409 pin_changed_again` (N4).
 * 6. The store's two refusals ("still going through", "key already used") are
 *    worded for the PIN, not for a payment (N1).
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

/** The fixed label the fingerprint key is derived with (WALLET-06 round 3, N3). Changing it makes every stored fingerprint unreadable. */
export const FINGERPRINT_LABEL = 'wawu-hub:pin-request-fingerprint:v1';
/** What every keyed fingerprint starts with, so a row written before round 3 (`$argon2id$...`) is told apart. */
export const FINGERPRINT_PREFIX = 'hmac-sha256:v1:';

/** The secret the fingerprint key is derived from: the one the Hub already requires at boot (WawuIdClient refuses to start in production without it). */
export const FINGERPRINT_SECRET_KEY = 'WAWU_ID_INTERNAL_SERVICE_KEY';
const DEV_FALLBACK = 'dev-internal-service-key-not-secret';

/** Who sent which key to which route. */
export type PinKeyIdentity = {
  wawuUserId: string;
  method: string;
  route: string;
  key: string;
};

/** The wording of the store's two refusals on each PIN route (N1): the PIN's, never the payments'. */
export const PIN_KEY_WORDS: Record<
  string,
  { inProgress: string; reused: string }
> = {
  'pin:change': {
    inProgress:
      'Your PIN change is still going through. Check again in a moment.',
    reused: 'Start again to change your PIN.',
  },
  'pin:reset-confirm': {
    inProgress:
      'Your PIN reset is still going through. Check again in a moment.',
    reused: 'Start again to reset your PIN.',
  },
};

/** N4: the repeat's PIN is no longer the PIN. */
export const CHANGED_AGAIN_MESSAGE =
  'Your PIN was changed again since. Check it in Wallet settings.';

/**
 * The fingerprints of PIN requests (N3). HMAC-SHA256 under a key derived from
 * the server's secret with a fixed label: a read of the table alone reveals
 * nothing about a PIN, and nobody without the secret can test a guess.
 *
 * `legacy` is the form written before round 3 (argon2id salted from the
 * person, route and key). It is only ever computed to read a row of that form
 * that has not expired yet (`PinRequestKeys.claim`); it is never written.
 * Remove it with that read once IDEMPOTENCY_KEY_HOURS have passed since round
 * 3 was deployed.
 */
@Injectable()
export class PinRequestFingerprints {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const configured = config.get<string>(FINGERPRINT_SECRET_KEY);
    if (!configured && process.env.NODE_ENV === 'production') {
      throw new Error(
        `${FINGERPRINT_SECRET_KEY} is not set. Refusing to start in production with the public development fallback.`,
      );
    }
    this.key = createHmac('sha256', configured || DEV_FALLBACK)
      .update(FINGERPRINT_LABEL)
      .digest();
  }

  /** The fingerprint the store compares a repeat against. The same request always gives the same text. */
  of(id: PinKeyIdentity, body: unknown): string {
    const message = JSON.stringify([
      id.wawuUserId,
      id.method,
      id.route,
      id.key,
      canonicalJson(body),
    ]);
    return (
      FINGERPRINT_PREFIX +
      createHmac('sha256', this.key).update(message, 'utf8').digest('hex')
    );
  }

  /** True for a fingerprint written before round 3. */
  isLegacy(fingerprint: string): boolean {
    return fingerprint.startsWith('$argon2id$');
  }

  /** The form written before round 3: argon2id of the body as canonical JSON, salted from person, route and key. */
  async legacy(id: PinKeyIdentity, body: unknown): Promise<string> {
    const salt = createHash('sha256')
      .update(`pin-request:${id.wawuUserId}:${id.method}:${id.route}:${id.key}`)
      .digest()
      .subarray(0, 16);
    return argon2.hash(canonicalJson(body), { type: argon2.argon2id, salt });
  }
}

/** What a service does inside the transaction that changes the PIN. */
export type InPinTransaction = (tx: Prisma.TransactionClient) => Promise<void>;

/** The new PIN a request carries, or null when the body has none that could be a PIN. */
function newPinOf(context: unknown): string | null {
  const pin = (context as { newPin?: unknown } | null | undefined)?.newPin;
  return typeof pin === 'string' && pin !== '' ? pin : null;
}

@Injectable()
export class PinRequestKeys implements OnModuleInit {
  private readonly logger = new Logger(PinRequestKeys.name);

  constructor(
    private readonly keys: IdempotencyService,
    private readonly prisma: PrismaService,
    private readonly fingerprints: PinRequestFingerprints,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` after the PIN changed (the request died before
    // it stored its answer) is answered from the PIN as it stands, but only
    // while the PIN is still the one this request set: the repeat carries the
    // same new PIN (the fingerprint matched), so the PIN either verifies
    // against it or has been changed again since (N4). Nothing is counted:
    // this compares the hash, it is not a PIN check.
    const answerFromPin = async (
      row: { resourceId: string | null },
      scope: IdempotencyScope,
    ) => {
      const pin = row.resourceId
        ? await this.prisma.transactionPin.findUnique({
            where: { wawuUserId: row.resourceId },
          })
        : null;
      if (!pin) return null;
      const carried = newPinOf(scope.context);
      if (carried === null) return null;
      const stillIt = await argon2
        .verify(pin.pinHash, carried)
        .catch(() => false);
      if (!stillIt) {
        throw new MoneyError('pin_changed_again', CHANGED_AGAIN_MESSAGE);
      }
      return { status: 200, body: okBody(pinStateView(pin, new Date())) };
    };
    for (const route of [PIN_CHANGE_ROUTE, PIN_RESET_CONFIRM_ROUTE]) {
      this.keys.onStale(route, STALE_CLAIM_SECONDS * 1000, answerFromPin);
    }
  }

  /**
   * Takes the key for this request, or throws what a repeat gets: the replay,
   * or the store's two refusals in the PIN's words (N1), or `409
   * pin_changed_again` (N4). A row written before round 3 holds the old
   * fingerprint: when the keyed one does not match and the row is of that
   * form and is this request's, the key is taken under the old form, so a
   * repeat of a request made before the deploy is read as before until its
   * row expires.
   */
  async claim(id: PinKeyIdentity, body: unknown): Promise<IdempotencyScope> {
    const context = { newPin: (body as { newPin?: unknown } | null)?.newPin };
    const scope: IdempotencyScope = {
      ...id,
      fingerprint: this.fingerprints.of(id, body),
      context,
    };
    try {
      scope.claimId = await this.keys.claim(scope);
      return scope;
    } catch (err) {
      const old = await this.legacyScope(err, id, body, context);
      if (!old) throw this.inPinWords(id.route, err);
      try {
        old.claimId = await this.keys.claim(old);
      } catch (again) {
        throw this.inPinWords(id.route, again);
      }
      // The claim was taken, not answered: the old row was a dead one, and
      // the store has written a new row of its own, with the old form. Round
      // 3 writes only the keyed form.
      const keyed = this.fingerprints.of(id, body);
      await this.prisma.moneyIdempotencyKey.updateMany({
        where: { ...id, claimId: old.claimId },
        data: { fingerprint: keyed },
      });
      old.fingerprint = keyed;
      return old;
    }
  }

  /** The old-form scope of this request, when the row holding its key is an unexpired one written before round 3 for exactly this body. */
  private async legacyScope(
    err: unknown,
    id: PinKeyIdentity,
    body: unknown,
    context: unknown,
  ): Promise<IdempotencyScope | null> {
    if (!(err instanceof MoneyError) || err.code !== 'idempotency_key_reused') {
      return null;
    }
    const row = await this.prisma.moneyIdempotencyKey.findUnique({
      where: {
        wawuUserId_method_route_key: {
          wawuUserId: id.wawuUserId,
          method: id.method,
          route: id.route,
          key: id.key,
        },
      },
      select: { fingerprint: true },
    });
    if (!row || !this.fingerprints.isLegacy(row.fingerprint)) return null;
    const fingerprint = await this.fingerprints.legacy(id, body);
    return fingerprint === row.fingerprint
      ? { ...id, fingerprint, context }
      : null;
  }

  /** The store's two refusals worded for the PIN route they came from (N1); anything else as it is. */
  inPinWords(route: string, err: unknown): unknown {
    const words = PIN_KEY_WORDS[route];
    if (!words || !(err instanceof MoneyError)) return err;
    if (err.code === 'idempotency_in_progress') {
      return new MoneyError('idempotency_in_progress', words.inProgress, {
        retryAfterSeconds: IN_PROGRESS_RETRY_SECONDS,
      });
    }
    if (err.code === 'idempotency_key_reused') {
      return new MoneyError('idempotency_key_reused', words.reused);
    }
    return err;
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
    let view: PinStateView;
    try {
      view = await work((tx) => this.keys.attach(tx, scope, wawuUserId));
    } catch (err) {
      // The link failed because the claim was taken over: the store's own
      // "still going through", in the PIN's words.
      throw this.inPinWords(scope.route, err);
    }
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
