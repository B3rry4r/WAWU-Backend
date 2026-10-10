import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ChangePinDto, SetPinDto } from '../dto/money-request.dto';
import { MoneyError } from '../money-error';
import { isUniqueViolation } from '../prisma-unique';
import type { PinStateView } from '../money-view.type';

/**
 * Wrong tries in a row before the PIN locks. The ticket's number (MONEY-09,
 * "locked after 5 wrong tries"; CONVENTIONS.md section 5).
 */
export const PIN_MAX_TRIES = 5;

/** The config key holding how long a lock lasts, in whole minutes. */
export const PIN_LOCK_MINUTES_KEY = 'PIN_LOCK_MINUTES';

/**
 * PROVISIONAL(PIN-LOCK-MINUTES, owner=YOU, why=no ruling or contract names the lock length)
 *
 * Used only when PIN_LOCK_MINUTES is not set. CONVENTIONS.md section 5 leaves
 * the length to MONEY-09's config and neither WALLET.md nor a ruling names
 * one, so this is the build default for the owner to confirm or replace in
 * config (task MONEY-09).
 */
export const DEFAULT_PIN_LOCK_MINUTES = 30;

/**
 * Reads PIN_LOCK_MINUTES. Unset (or empty) means the provisional default; a
 * value that is set but not a whole number of minutes of at least 1 stops the
 * app at boot rather than locking people for a length nobody chose.
 */
export function pinLockMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PIN_LOCK_MINUTES;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(
      `${PIN_LOCK_MINUTES_KEY} must be a whole number of minutes, 1 or more.`,
    );
  }
  return minutes;
}

type PinRow = {
  pinHash: string;
  failedTries: number;
  lockedUntil: Date | null;
  setAt: Date;
};

/** What a PIN state is read from (a full row passes; the view never carries the hash). */
type PinStateRow = Pick<PinRow, 'failedTries' | 'lockedUntil' | 'setAt'> &
  Partial<Pick<PinRow, 'pinHash'>>;

/** A reserved check older than this belongs to a check that died: its slot is free. */
export const PIN_SLOT_STALE_MS = 30_000;
/** How long a check waits for a slot before it looks again (a woken one looks at once). */
const SLOT_POLL_MS = 150;
/** The longest a check waits for a slot: past a dead one's staleness, with margin. */
const SLOT_WAIT_LIMIT_MS = PIN_SLOT_STALE_MS + 10_000;

/** What GET /money/pin answers. A lock that has ended reads as no lock. */
export function pinStateView(row: PinStateRow | null, now: Date): PinStateView {
  if (!row) {
    return {
      isSet: false,
      changedAt: null,
      triesLeft: PIN_MAX_TRIES,
      lockedUntil: null,
    };
  }
  const locked = row.lockedUntil !== null && row.lockedUntil > now;
  const lockEnded = row.lockedUntil !== null && !locked;
  return {
    isSet: true,
    changedAt: row.setAt.toISOString(),
    triesLeft: locked
      ? 0
      : Math.max(0, PIN_MAX_TRIES - (lockEnded ? 0 : row.failedTries)),
    lockedUntil: locked ? row.lockedUntil!.toISOString() : null,
  };
}

/** Prisma's "the row the update targeted was not found" (P2025). */
function isNoMatch(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2025'
  );
}

const NOT_SET_MESSAGE = 'Create your transaction PIN first.';
const ALREADY_SET_MESSAGE = 'You already have a transaction PIN.';
const MISMATCH_MESSAGE = 'The two PINs do not match. Enter the same PIN twice.';
const LOCKED_MESSAGE = 'Too many wrong PINs. Try again when the lock ends.';

function incorrectMessage(triesLeft: number): string {
  return `Wrong PIN. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`;
}

/**
 * The transaction PIN (task MONEY-09; docs/contract/CONVENTIONS.md section 5).
 *
 * - Stored only as an argon2id hash. argon2 makes a fresh random salt for
 *   every hash, so every person's PIN (and every new PIN) has its own salt,
 *   and `argon2.verify` compares with `crypto.timingSafeEqual`.
 * - Five wrong tries in a row lock it for PIN_LOCK_MINUTES. A right PIN, a
 *   new PIN, or the end of a lock puts the count back to 0.
 * - A check RESERVES a slot before the hash is compared, in one conditional
 *   update (`failedTries + pendingTries` below the limit), compares with no
 *   transaction and no row lock open, and then records the result in one
 *   more update that also gives the slot back (MONEY-17 round 3). So: wrong
 *   PINs sent at the same moment can never be compared past the limit (only
 *   as many as there are slots are compared at all); a right PIN never uses
 *   up a try, however many arrive together (it clears the count when it is
 *   recorded); the fifth wrong result sets the lock in the same write; and
 *   while argon2 runs nothing in the database is held, so one person's
 *   checks cannot hold up anyone else's requests. A check that finds every
 *   slot taken waits for one (in memory, holding no connection) and then
 *   looks again; it answers the lock as soon as there is one.
 * - A slot left by a check that died is free again after PIN_SLOT_STALE_MS. A
 *   check that is only slow (a saturated thread pool) can lose its slot the
 *   same way, so more than five wrong compares can happen; what holds is
 *   what is ANSWERED: every wrong compare still counts when it is recorded
 *   (so at most four are ever answered "wrong, N tries left" before the
 *   lock), a lock already set is never extended by a late one, and a PIN
 *   that is locked when a result is recorded answers `423 pin_locked`, a
 *   right PIN included (R3-2).
 * - Nothing here logs, and no message carries what the caller sent.
 *
 * The routes and the X-Transaction-Pin guard are thin: every rule is here.
 */
@Injectable()
export class TransactionPinService {
  private readonly lockMs: number;
  private readonly slots = new SlotQueue();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.lockMs =
      pinLockMinutes(config.get<string>(PIN_LOCK_MINUTES_KEY)) * 60_000;
  }

  async state(wawuUserId: string): Promise<PinStateView> {
    const row = await this.prisma.transactionPin.findUnique({
      where: { wawuUserId },
    });
    return pinStateView(row, new Date());
  }

  /** POST /money/pin: the first PIN. */
  async set(wawuUserId: string, dto: SetPinDto): Promise<PinStateView> {
    const existing = await this.prisma.transactionPin.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (existing) throw new MoneyError('pin_already_set', ALREADY_SET_MESSAGE);
    if (dto.pin !== dto.pinConfirmation) {
      throw new MoneyError('pin_mismatch', MISMATCH_MESSAGE);
    }
    const pinHash = await hashPin(dto.pin);
    try {
      const row = await this.prisma.transactionPin.create({
        data: { wawuUserId, pinHash },
      });
      return pinStateView(row, new Date());
    } catch (err) {
      // Two first PINs at the same moment: the primary key lets one in.
      if (isUniqueViolation(err)) {
        throw new MoneyError('pin_already_set', ALREADY_SET_MESSAGE);
      }
      throw err;
    }
  }

  /**
   * PUT /money/pin. The current PIN has already been checked by
   * TransactionPinGuard on the same request; this only replaces it.
   */
  async change(wawuUserId: string, dto: ChangePinDto): Promise<PinStateView> {
    if (dto.newPin !== dto.newPinConfirmation) {
      throw new MoneyError('pin_mismatch', MISMATCH_MESSAGE);
    }
    const pinHash = await hashPin(dto.newPin);
    try {
      const row = await this.prisma.transactionPin.update({
        where: { wawuUserId },
        data: { pinHash, failedTries: 0, lockedUntil: null, setAt: new Date() },
      });
      return pinStateView(row, new Date());
    } catch (err) {
      if (isNoMatch(err)) throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
      throw err;
    }
  }

  /**
   * Checks a PIN and answers the PIN's state when it is right. Refuses with
   * 409 pin_not_set, 403 pin_incorrect (triesLeft) or 423 pin_locked
   * (lockedUntil). The fifth wrong try in a row answers pin_locked, so the
   * screen shows the lock at once instead of "0 tries left".
   */
  async verify(wawuUserId: string, pin: string): Promise<PinStateView> {
    const slot = await this.reserve(wawuUserId);
    let right: boolean;
    try {
      // No transaction, no row lock and no connection are held here.
      right = await argon2.verify(slot.pinHash, pin);
    } catch (err) {
      // The compare itself failed (a damaged hash): the slot is given back
      // and no try is counted either way.
      await this.finish(wawuUserId, slot.pinHash, 'release');
      throw err;
    }
    const done = await this.finish(
      wawuUserId,
      slot.pinHash,
      right ? 'right' : 'wrong',
    );
    const now = new Date();
    // The lock is read from the very update that recorded this result: a PIN
    // that is locked when its result is recorded is never answered as right,
    // however long the compare took (MONEY-17 round 4, R3-2), and a wrong PIN
    // recorded after the lock is told so, never "wrong, N tries left".
    if (done.row.lockedUntil && done.row.lockedUntil > now) {
      throw lockedError(done.row.lockedUntil);
    }
    if (right) return pinStateView(done.row, now);
    const triesLeft = Math.max(0, PIN_MAX_TRIES - done.row.failedTries);
    throw new MoneyError('pin_incorrect', incorrectMessage(triesLeft), {
      triesLeft,
    });
  }

  /**
   * Takes a slot for one check: a single conditional update that only
   * matches while the PIN is not locked and `failedTries + pendingTries` is
   * below the limit, and answers the hash to compare. A lock that has ended
   * starts the count again in the same write; a slot older than
   * PIN_SLOT_STALE_MS counts as free. Refuses with `409 pin_not_set` and
   * `423 pin_locked`; when every slot is taken by checks still running, waits
   * for one without holding a connection.
   */
  private async reserve(wawuUserId: string): Promise<{ pinHash: string }> {
    const giveUpAt = Date.now() + SLOT_WAIT_LIMIT_MS;
    for (;;) {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - PIN_SLOT_STALE_MS);
      const taken = await this.prisma.$queryRaw<Array<{ pinHash: string }>>`
        UPDATE "TransactionPin" SET
          "failedTries" = CASE WHEN "lockedUntil" IS NOT NULL THEN 0 ELSE "failedTries" END,
          "lockedUntil" = NULL,
          "pendingTries" = (CASE WHEN "pendingSince" IS NULL OR "pendingSince" < ${staleBefore} THEN 0 ELSE "pendingTries" END) + 1,
          "pendingSince" = ${now},
          "updatedAt" = ${now}
        WHERE "wawuUserId" = ${wawuUserId}
          AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
          AND (CASE WHEN "lockedUntil" IS NOT NULL THEN 0 ELSE "failedTries" END)
            + (CASE WHEN "pendingSince" IS NULL OR "pendingSince" < ${staleBefore} THEN 0 ELSE "pendingTries" END)
            < ${PIN_MAX_TRIES}
        RETURNING "pinHash"`;
      if (taken.length === 1) return taken[0];
      const row = await this.prisma.transactionPin.findUnique({
        where: { wawuUserId },
        select: { lockedUntil: true },
      });
      if (!row) throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
      if (row.lockedUntil && row.lockedUntil > now) {
        throw lockedError(row.lockedUntil);
      }
      // Every try this person may have is being compared right now. Whether
      // the PIN locks depends on those results, so this check waits for one.
      if (Date.now() >= giveUpAt) {
        throw new ServiceUnavailableException(
          'Too many PIN checks at once. Try again in a moment.',
        );
      }
      await this.slots.wait(wawuUserId, SLOT_POLL_MS);
    }
  }

  /**
   * Records a finished check and gives its slot back, in one update. A wrong
   * PIN counts as a failed try (the fifth sets the lock in the same write); a
   * right one clears the count. The count only changes while the stored hash
   * is still the one compared (a PIN changed meanwhile keeps its own count);
   * the slot is given back either way. Wakes the checks waiting for a slot.
   */
  private async finish(
    wawuUserId: string,
    comparedHash: string,
    result: 'right' | 'wrong' | 'release',
  ): Promise<{ row: PinStateRow }> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + this.lockMs);
    const wrong = result === 'wrong';
    const right = result === 'right';
    const rows = await this.prisma.$queryRaw<
      Array<PinStateRow & { pendingTries: number }>
    >`
      UPDATE "TransactionPin" SET
        "pendingTries" = GREATEST("pendingTries" - 1, 0),
        "pendingSince" = CASE WHEN "pendingTries" <= 1 THEN NULL ELSE "pendingSince" END,
        "failedTries" = CASE
          WHEN "pinHash" <> ${comparedHash} THEN "failedTries"
          WHEN ${wrong} THEN LEAST("failedTries" + 1, ${PIN_MAX_TRIES})
          WHEN ${right} AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now}) THEN 0
          ELSE "failedTries" END,
        "lockedUntil" = CASE
          WHEN "pinHash" <> ${comparedHash} THEN "lockedUntil"
          WHEN ${wrong} AND "failedTries" + 1 >= ${PIN_MAX_TRIES}
            AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now}) THEN ${lockedUntil}
          WHEN ${right} AND "lockedUntil" <= ${now} THEN NULL
          ELSE "lockedUntil" END,
        "updatedAt" = ${now}
      WHERE "wawuUserId" = ${wawuUserId}
      RETURNING "failedTries", "lockedUntil", "setAt", "pendingTries"`;
    const row =
      rows[0] ??
      (await this.prisma.transactionPin.findUnique({
        where: { wawuUserId },
        select: { failedTries: true, lockedUntil: true, setAt: true },
      }));
    if (!row) throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
    const pending = 'pendingTries' in row ? row.pendingTries : 0;
    const locked = row.lockedUntil !== null && row.lockedUntil > now;
    // A lock wakes everyone (each will answer it); otherwise one waiter per
    // slot that is free now.
    this.slots.release(
      wawuUserId,
      locked
        ? Infinity
        : Math.max(0, PIN_MAX_TRIES - row.failedTries - pending),
    );
    return { row };
  }

  /**
   * For an approval that is not the PIN (a biometric approval, MONEY-14):
   * refuses while the PIN is locked (`423 pin_locked`) or when there is no
   * PIN (`409 pin_not_set`). Reads only: it neither uses nor resets a try.
   */
  async assertNotLocked(wawuUserId: string): Promise<void> {
    const row = await this.prisma.transactionPin.findUnique({
      where: { wawuUserId },
      select: { lockedUntil: true },
    });
    if (!row) throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
    if (row.lockedUntil && row.lockedUntil > new Date()) {
      throw lockedError(row.lockedUntil);
    }
  }
}

function lockedError(lockedUntil: Date): MoneyError {
  return new MoneyError('pin_locked', LOCKED_MESSAGE, {
    lockedUntil: lockedUntil.toISOString(),
  });
}

function hashPin(pin: string): Promise<string> {
  return argon2.hash(pin, { type: argon2.argon2id });
}

/**
 * The checks of one process waiting for a slot, per person, first come first
 * served. Nothing here touches the database: a waiter holds no connection. A
 * waiter that is not woken looks again after `ms` (another server may have
 * freed the slot).
 */
class SlotQueue {
  private readonly queues = new Map<string, Array<() => void>>();

  wait(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const queue = this.queues.get(id) ?? [];
      this.queues.set(id, queue);
      const wake = () => {
        clearTimeout(timer);
        const at = queue.indexOf(wake);
        if (at >= 0) queue.splice(at, 1);
        if (queue.length === 0 && this.queues.get(id) === queue) {
          this.queues.delete(id);
        }
        resolve();
      };
      const timer = setTimeout(wake, ms);
      queue.push(wake);
    });
  }

  /** Wakes up to `n` waiters of this person, oldest first. */
  release(id: string, n: number): void {
    const queue = this.queues.get(id);
    if (!queue) return;
    for (const wake of queue.slice(0, n)) wake();
  }
}
