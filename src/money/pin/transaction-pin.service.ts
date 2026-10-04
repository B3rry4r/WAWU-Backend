import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ChangePinDto, SetPinDto } from '../dto/money-request.dto';
import { MoneyError } from '../money-error';
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

/** What GET /money/pin answers. A lock that has ended reads as no lock. */
export function pinStateView(row: PinRow | null, now: Date): PinStateView {
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

/** Prisma's unique-constraint refusal (P2002). */
function isDuplicate(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
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
 * - Tries are checked one at a time per person, under a lock on the PIN
 *   row held for the whole check (MONEY-17 round 2): tries sent at the same
 *   moment cannot get past the limit together, and a right PIN never uses
 *   up a try, however many arrive at once. The fifth wrong try sets the
 *   lock in the same write. A right PIN clears the count.
 * - Nothing here logs, and no message carries what the caller sent.
 *
 * The routes and the X-Transaction-Pin guard are thin: every rule is here.
 */
@Injectable()
export class TransactionPinService {
  private readonly lockMs: number;

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
      if (isDuplicate(err)) {
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
    // One check at a time per person (MONEY-17 round 2): the PIN row is
    // locked for the whole check, so tries sent at the same moment are
    // counted one after another. A right PIN never uses up a try, however
    // many arrive together (8 payments at once with the right PIN used to
    // lock it), and wrong ones still cannot get past the limit together.
    const outcome = await this.prisma.$transaction(
      async (
        tx,
      ): Promise<
        | { kind: 'ok'; row: PinRow }
        | { kind: 'not_set' }
        | { kind: 'locked'; until: Date }
        | { kind: 'wrong'; triesLeft: number }
      > => {
        const now = new Date();
        await tx.$queryRaw`
          SELECT 1 FROM "TransactionPin" WHERE "wawuUserId" = ${wawuUserId} FOR UPDATE`;
        const row = await tx.transactionPin.findUnique({
          where: { wawuUserId },
        });
        if (!row) return { kind: 'not_set' };
        if (row.lockedUntil && row.lockedUntil > now) {
          return { kind: 'locked', until: row.lockedUntil };
        }
        // A lock that has ended starts the count again.
        const before = row.lockedUntil ? 0 : row.failedTries;
        if (await argon2.verify(row.pinHash, pin)) {
          const fresh =
            before === 0 && !row.lockedUntil
              ? row
              : await tx.transactionPin.update({
                  where: { wawuUserId },
                  data: { failedTries: 0, lockedUntil: null },
                });
          return { kind: 'ok', row: fresh };
        }
        const failedTries = before + 1;
        if (failedTries >= PIN_MAX_TRIES) {
          const until = new Date(now.getTime() + this.lockMs);
          await tx.transactionPin.update({
            where: { wawuUserId },
            data: { failedTries: PIN_MAX_TRIES, lockedUntil: until },
          });
          return { kind: 'locked', until };
        }
        await tx.transactionPin.update({
          where: { wawuUserId },
          data: { failedTries, lockedUntil: null },
        });
        return { kind: 'wrong', triesLeft: PIN_MAX_TRIES - failedTries };
      },
      { maxWait: 30_000, timeout: 30_000 },
    );
    switch (outcome.kind) {
      case 'ok':
        return pinStateView(outcome.row, new Date());
      case 'not_set':
        throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
      case 'locked':
        throw lockedError(outcome.until);
      case 'wrong':
        throw new MoneyError(
          'pin_incorrect',
          incorrectMessage(outcome.triesLeft),
          { triesLeft: outcome.triesLeft },
        );
    }
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
