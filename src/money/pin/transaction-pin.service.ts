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
 * - A try is COUNTED BEFORE the hash is compared, in one conditional update,
 *   so tries sent at the same moment cannot get past the limit together:
 *   only the tries that won a slot are compared at all, and the fifth slot
 *   sets the lock in the same write. A right PIN then clears both.
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
    const now = new Date();

    // A lock that has ended starts the count again.
    await this.prisma.transactionPin.updateMany({
      where: { wawuUserId, lockedUntil: { lte: now } },
      data: { failedTries: 0, lockedUntil: null },
    });

    const claimed = await this.claimTry(wawuUserId, now);

    if (await argon2.verify(claimed.pinHash, pin)) {
      const row = await this.prisma.transactionPin.update({
        where: { wawuUserId },
        data: { failedTries: 0, lockedUntil: null },
      });
      return pinStateView(row, new Date());
    }

    if (claimed.lockedUntil) throw lockedError(claimed.lockedUntil);
    const triesLeft = PIN_MAX_TRIES - claimed.failedTries;
    throw new MoneyError('pin_incorrect', incorrectMessage(triesLeft), {
      triesLeft,
    });
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

  /**
   * Takes one try before the PIN is compared. Tries 1 to 4 only count; the
   * fifth also sets the lock, in the same write, so a concurrent try already
   * sees it locked. Each step is a single conditional update: whichever
   * request wins the row's next slot is the only one compared against it.
   */
  private async claimTry(wawuUserId: string, now: Date): Promise<PinRow> {
    try {
      return await this.prisma.transactionPin.update({
        where: {
          wawuUserId,
          lockedUntil: null,
          failedTries: { lt: PIN_MAX_TRIES - 1 },
        },
        data: { failedTries: { increment: 1 } },
      });
    } catch (err) {
      if (!isNoMatch(err)) throw err;
    }
    try {
      return await this.prisma.transactionPin.update({
        where: {
          wawuUserId,
          lockedUntil: null,
          failedTries: PIN_MAX_TRIES - 1,
        },
        data: {
          failedTries: { increment: 1 },
          lockedUntil: new Date(now.getTime() + this.lockMs),
        },
      });
    } catch (err) {
      if (!isNoMatch(err)) throw err;
    }

    const row = await this.prisma.transactionPin.findUnique({
      where: { wawuUserId },
    });
    if (!row) throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
    // No slot left, so it is locked: the fifth try sets lockedUntil in the
    // same write that takes the last slot, and every reset clears both.
    throw lockedError(row.lockedUntil ?? new Date(now.getTime() + this.lockMs));
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
