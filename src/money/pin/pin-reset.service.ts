import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OTP_SENDER,
  type OtpSender,
} from '../../wallet-provider/wallet-provider.interface';
import {
  WALLET_PROVIDER_UNKNOWN_OUTCOMES,
  WalletProviderError,
} from '../../wallet-provider/wallet-provider-error';
import type { ConfirmPinResetDto } from '../dto/money-request.dto';
import { MoneyError } from '../money-error';
import type { PinResetView, PinStateView } from '../money-view.type';
import {
  PinResetSettings,
  RESET_CODE_DIGITS,
  RESET_TRIES_PER_CODE,
  RESET_WINDOW_MS,
} from './pin-reset-config';
import { pinStateView } from './transaction-pin.service';

const NOT_SET_MESSAGE = 'Create your transaction PIN first.';
const MISMATCH_MESSAGE = 'The two PINs do not match. Enter the same PIN twice.';
const NO_PHONE_MESSAGE =
  'Open your wallet first. The code goes to the phone number your BVN check confirmed.';
const EXHAUSTED_MESSAGE =
  'You have asked for too many codes today. Try again later.';
const NOT_SENT_MESSAGE =
  'We could not send the code right now. Try again in a moment.';
const MAYBE_SENT_MESSAGE =
  'We could not confirm the code was sent. If it arrives, use it; otherwise ask for a new one when Resend opens.';
const CODE_INVALID_MESSAGE =
  'That code is not right or has expired. Check it, or ask for a new one.';

/** `+234 *** *** 4412`: the last 4 digits only (W37's "sent to"). */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return `+234 *** *** ${digits.slice(-4)}`;
}

/** The text that carries the code. Copy the canvas does not draw (listed in the task file). */
export function resetCodeText(code: string, minutes: number): string {
  return `Your Who Made This code to reset your transaction PIN is ${code}. It expires in ${minutes} minutes. Never share it with anyone.`;
}

/** Prisma's "the row the update targeted was not found" (P2025). */
function isNoMatch(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2025'
  );
}

function newCode(): string {
  return randomInt(0, 10 ** RESET_CODE_DIGITS)
    .toString()
    .padStart(RESET_CODE_DIGITS, '0');
}

type ResetRow = {
  id: string;
  phone: string;
  expiresAt: Date;
  resendAvailableAt: Date;
};

function resetView(row: ResetRow): PinResetView {
  return {
    resetId: row.id,
    sentTo: maskPhone(row.phone),
    resendAvailableAt: row.resendAvailableAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function invalidCode(triesLeft: number): MoneyError {
  return new MoneyError('reset_code_invalid', CODE_INVALID_MESSAGE, {
    triesLeft: Math.max(0, triesLeft),
  });
}

/**
 * Resetting the transaction PIN by a code texted to the phone (task
 * MONEY-14, W37; docs/contract/CONVENTIONS.md section 5).
 *
 * A reset proves the person again, so it is never weaker than the PIN it
 * replaces:
 * - The code goes only to the phone the BVN check proved
 *   (`WalletIdentity.verifiedPhone`, G-11), never to a number the caller or
 *   the token names. No proved phone, no reset (`409 wallet_not_open`).
 * - Six random digits (a million codes against the PIN's ten thousand),
 *   stored only as an argon2id hash, alive PIN_RESET_CODE_SECONDS, five
 *   wrong tries a code (the PIN's own five), only the newest code works, and
 *   a code works once. A wrong try is counted before the code is compared,
 *   in one conditional update, so codes sent at the same moment cannot get
 *   past five together.
 * - PIN_RESET_TEXTS_PER_DAY texts in any 24 hours, per person and per phone
 *   (`429 reset_codes_exhausted`), so a day allows at most 25 guesses at a
 *   six-digit code against 240 at the four-digit PIN, and caps the spend.
 * - Asking again before Resend opens answers the same reset and sends
 *   nothing: a double tap is one text.
 * - A text whose answer was lost may have arrived: its code stays usable
 *   and it counts, and it is never sent again blindly. A text the sender
 *   refused, or that never left, does not count and its code never works.
 * - The right code sets the new PIN, clears the wrong-try count and the
 *   lock, and turns off biometric approval on every phone (the person
 *   proves themselves afresh, and a lost phone stops approving). All in one
 *   transaction with marking the code used.
 * - The code and the PINs never reach a log, an error or a response.
 * - The text goes through the OTP_SENDER seam (MONEY-20): Fintava's SMS
 *   today; never a provider's client.
 */
@Injectable()
export class PinResetService {
  private readonly logger = new Logger(PinResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_SENDER) private readonly otp: OtpSender,
    private readonly settings: PinResetSettings,
  ) {}

  /** POST /money/pin/reset. */
  async start(wawuUserId: string): Promise<PinResetView> {
    const pin = await this.prisma.transactionPin.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (!pin) throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);

    const identity = await this.prisma.walletIdentity.findUnique({
      where: { wawuUserId },
      select: { verifiedPhone: true, bvnVerifiedAt: true },
    });
    const phone = identity?.bvnVerifiedAt ? identity.verifiedPhone : null;
    if (!phone) throw new MoneyError('wallet_not_open', NO_PHONE_MESSAGE);

    const code = newCode();
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });

    const claim = await this.prisma.$transaction(async (tx) => {
      // One start at a time per person: a double tap waits here and then
      // finds the reset the first tap made.
      await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${`pin-reset:${wawuUserId}`}, 0))`;
      const now = new Date();
      const live = await tx.transactionPinReset.findFirst({
        where: {
          wawuUserId,
          usedAt: null,
          supersededAt: null,
          sendState: { not: 'failed' },
          resendAvailableAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (live) return { kind: 'again' as const, row: live };

      const since = new Date(now.getTime() - RESET_WINDOW_MS);
      const counted = await tx.transactionPinReset.findMany({
        where: {
          OR: [{ wawuUserId }, { phone }],
          createdAt: { gt: since },
          sendState: { not: 'failed' },
        },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      if (counted.length >= this.settings.textsPerDay) {
        const oldest = counted[counted.length - this.settings.textsPerDay];
        const freeAt = oldest.createdAt.getTime() + RESET_WINDOW_MS;
        return {
          kind: 'exhausted' as const,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((freeAt - now.getTime()) / 1000),
          ),
        };
      }

      // Only the newest code works.
      await tx.transactionPinReset.updateMany({
        where: { wawuUserId, usedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      const row = await tx.transactionPinReset.create({
        data: {
          wawuUserId,
          phone,
          codeHash,
          expiresAt: new Date(now.getTime() + this.settings.codeMs),
          resendAvailableAt: new Date(now.getTime() + this.settings.resendMs),
        },
      });
      return { kind: 'new' as const, row };
    });

    if (claim.kind === 'exhausted') {
      throw new MoneyError('reset_codes_exhausted', EXHAUSTED_MESSAGE, {
        retryAfterSeconds: claim.retryAfterSeconds,
      });
    }
    if (claim.kind === 'again') return resetView(claim.row);

    const row = claim.row;
    const minutes = Math.max(1, Math.round(this.settings.codeMs / 60_000));
    try {
      await this.otp.sendText(phone, resetCodeText(code, minutes));
    } catch (err) {
      if (!(err instanceof WalletProviderError)) throw err;
      const resendIn = Math.max(
        1,
        Math.ceil((row.resendAvailableAt.getTime() - Date.now()) / 1000),
      );
      if (WALLET_PROVIDER_UNKNOWN_OUTCOMES.includes(err.kind)) {
        // It may have arrived: keep the code, count the text, send nothing
        // more until Resend opens. Asking again meanwhile answers this reset.
        await this.prisma.transactionPinReset.update({
          where: { id: row.id },
          data: { sendState: 'unknown' },
        });
        this.logger.warn(
          `pin reset ${row.id}: the text's outcome is unknown (${err.kind})`,
        );
        throw new MoneyError('provider_unreachable', MAYBE_SENT_MESSAGE, {
          retryAfterSeconds: resendIn,
        });
      }
      // Not sent: the code never works and the text is not counted.
      await this.prisma.transactionPinReset.update({
        where: { id: row.id },
        data: { sendState: 'failed', supersededAt: new Date() },
      });
      this.logger.warn(
        `pin reset ${row.id}: the text was not sent (${err.kind})`,
      );
      throw new MoneyError('provider_unreachable', NOT_SENT_MESSAGE, {
        retryAfterSeconds: err.retryAfterSeconds,
      });
    }
    await this.prisma.transactionPinReset.updateMany({
      where: { id: row.id, sendState: 'sending' },
      data: { sendState: 'sent' },
    });
    return resetView(row);
  }

  /** POST /money/pin/reset/confirm. */
  async confirm(
    wawuUserId: string,
    dto: ConfirmPinResetDto,
  ): Promise<PinStateView> {
    // Nothing secret is compared yet, so a mismatch uses no try of the code.
    if (dto.newPin !== dto.newPinConfirmation) {
      throw new MoneyError('pin_mismatch', MISMATCH_MESSAGE);
    }

    const claimed = await this.claimTry(wawuUserId, dto.resetId);
    if (!claimed) throw invalidCode(0);
    if (!(await argon2.verify(claimed.codeHash, dto.code))) {
      throw invalidCode(RESET_TRIES_PER_CODE - claimed.failedTries);
    }

    const pinHash = await argon2.hash(dto.newPin, { type: argon2.argon2id });
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // A code works once: of two right codes at the same moment, one wins.
      const used = await tx.transactionPinReset.updateMany({
        where: { id: claimed.id, wawuUserId, usedAt: null, supersededAt: null },
        data: { usedAt: now },
      });
      if (used.count !== 1) throw invalidCode(0);
      const updated = await tx.transactionPin.updateMany({
        where: { wawuUserId },
        data: { pinHash, failedTries: 0, lockedUntil: null, setAt: now },
      });
      if (updated.count !== 1) {
        throw new MoneyError('pin_not_set', NOT_SET_MESSAGE);
      }
      // The person proved themselves afresh: no phone approves with a
      // fingerprint or face until they turn it on again with the new PIN.
      await tx.approvalDevice.deleteMany({ where: { wawuUserId } });
      await tx.approvalChallenge.deleteMany({ where: { wawuUserId } });
      const row = await tx.transactionPin.findUniqueOrThrow({
        where: { wawuUserId },
      });
      return pinStateView(row, now);
    });
  }

  /**
   * Takes one try of the code before it is compared, in one conditional
   * update: only a live, unused, newest code with a try left gets one.
   * Someone else's resetId finds nothing, the same as a dead one.
   */
  private async claimTry(
    wawuUserId: string,
    resetId: string,
  ): Promise<{ id: string; codeHash: string; failedTries: number } | null> {
    try {
      return await this.prisma.transactionPinReset.update({
        where: {
          id: resetId,
          wawuUserId,
          usedAt: null,
          supersededAt: null,
          sendState: { not: 'failed' },
          expiresAt: { gt: new Date() },
          failedTries: { lt: RESET_TRIES_PER_CODE },
        },
        data: { failedTries: { increment: 1 } },
        select: { id: true, codeHash: true, failedTries: true },
      });
    } catch (err) {
      if (isNoMatch(err)) return null;
      throw err;
    }
  }
}
