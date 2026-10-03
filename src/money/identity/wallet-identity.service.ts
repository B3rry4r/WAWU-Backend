import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FintavaClient,
  toFintavaLocalPhone,
} from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import {
  FintavaError,
  type FintavaErrorKind,
} from '../../fintava/fintava-error';
import type { FintavaBvnIdentity } from '../../fintava/fintava.interface';
import { Prisma } from '../../../generated/prisma/client';
import { MoneyError } from '../money-error';
import { bvnNameKeys } from './bvn-name';
import type { BvnCheckDto } from './dto/identity-request.dto';
import {
  BVN_CHECK_WINDOW_MS,
  type DailyAttemptLedger,
  IdentityHasher,
  reserveDailyAttempt,
} from './identity-config';
import type {
  BvnCheckView,
  BvnGender,
  BvnPrefillView,
  WalletIdentityView,
} from './identity-view.type';

/** A14, word for word: the design shows no part of the BVN's phone. */
export const BVN_PHONE_MISMATCH_MESSAGE =
  "This isn't the number on your BVN. Use that one.";
export const BVN_NOT_CONFIRMED_MESSAGE =
  'We could not confirm that BVN. Check the number and try again.';
export const PHONE_NOT_NIGERIAN_MESSAGE =
  'A Naira wallet needs a Nigerian phone number on your account.';
export const CHECKS_EXHAUSTED_MESSAGE =
  'You have used today’s BVN checks. Try again later.';
export const IDENTITY_UNAVAILABLE_MESSAGE =
  'We could not check your BVN right now. Try again in a moment.';
export const BVN_NOT_CHECKED_MESSAGE = 'Confirm your BVN first.';
export const WALLET_ALREADY_OPEN_MESSAGE = 'Your wallet is already open.';

/**
 * Fintava kinds after which nothing reached the BVN provider, so nothing was
 * charged and the try is given back: no key or no base URL (not sent at
 * all), a key Fintava refused, or the merchant gate (a 403 there was not
 * charged, `sandbox/04-bvn-check.md` in the mobile repo).
 */
const NOT_CHARGED: readonly FintavaErrorKind[] = [
  'not_configured',
  'auth',
  'merchant_inactive',
];

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Fintava documents `1992-10-04`; NIBSS records are often `04-Oct-1992`.
 * Both are read; anything else is null rather than a guess.
 */
export function bvnDateOfBirth(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/](\d{4})$/.exec(v);
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (month === 0) return null;
    return validDate(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

export function bvnGender(raw: string | null): BvnGender | null {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === 'male' || v === 'm') return 'male';
  if (v === 'female' || v === 'f') return 'female';
  return null;
}

function name(raw: string | null): string | null {
  const v = raw?.trim() ?? '';
  return v === '' ? null : v;
}

/** A5's card, from Fintava's answer. The photo is never passed on. */
export function bvnPrefill(identity: FintavaBvnIdentity): BvnPrefillView {
  return {
    firstName: name(identity.firstName),
    middleName: name(identity.middleName),
    lastName: name(identity.lastName),
    dateOfBirth: bvnDateOfBirth(identity.dateOfBirth),
    gender: bvnGender(identity.gender),
  };
}

/** A passed BVN check: when it passed, and the keyed hash of its BVN. */
export type PassedBvnCheck = { verifiedAt: Date; bvnHash: string };

/**
 * A passed BVN check whose BVN and NIN are the ones account opening was
 * sent (MONEY-12), read once: the check, and the phone it proved (E.164).
 */
export type CheckedIdentity = PassedBvnCheck & { verifiedPhone: string };

type IdentityRow = {
  bvnLast4: string | null;
  bvnVerifiedAt: Date | null;
  ninLast4: string | null;
  occupation: string | null;
};

/**
 * Open your wallet's identity step (task KYC-01, R-6): the BVN check, its
 * daily limit, and the occupation typed on A5.
 *
 * The full BVN and NIN live only in the request that carries them. They are
 * hashed (IdentityHasher) before anything touches the database, are never
 * logged (the MONEY-06 client logs no URL, body or header, and masks digit
 * runs in Fintava's messages), and never come back in an answer: only their
 * last 4 digits do. The BVN record's name, date of birth and gender go back
 * once, in the answer to a check that passed, and only when the BVN's phone
 * is the account's, so a BVN typed by someone else reveals nothing.
 *
 * Everything is keyed on the caller's token: no route names another person.
 */
@Injectable()
export class WalletIdentityService {
  private readonly logger = new Logger(WalletIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
    private readonly hasher: IdentityHasher,
  ) {}

  async view(wawuUserId: string): Promise<WalletIdentityView> {
    const [row, used] = await Promise.all([
      this.row(wawuUserId),
      this.checksUsed(wawuUserId),
    ]);
    return this.toView(row, this.left(used));
  }

  async checkBvn(
    wawuUserId: string,
    accountPhone: string | null | undefined,
    input: BvnCheckDto,
  ): Promise<BvnCheckView> {
    if (
      !this.hasher.configured ||
      this.fintava.environment === 'unconfigured'
    ) {
      throw this.unavailable();
    }
    // Hashed first: from here on only hashes and last 4 digits are handled.
    const bvnHash = this.hasher.hash('bvn', input.bvn);
    const ninHash = this.hasher.hash('nin', input.nin);
    const bvnLast4 = input.bvn.slice(-4);
    const ninLast4 = input.nin.slice(-4);

    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (wallet) {
      throw new MoneyError('wallet_already_open', WALLET_ALREADY_OPEN_MESSAGE);
    }
    const ownPhone = toFintavaLocalPhone(accountPhone ?? '');
    if (!ownPhone) {
      throw new MoneyError('phone_not_nigerian', PHONE_NOT_NIGERIAN_MESSAGE);
    }

    const attempt = await this.reserve(wawuUserId);
    let identity: FintavaBvnIdentity;
    try {
      identity = await this.fintava.verifyBvn(input.bvn);
    } catch (e) {
      if (!(e instanceof FintavaError)) {
        await this.settle(attempt.id, 'unavailable');
        throw e;
      }
      if (NOT_CHARGED.includes(e.kind)) {
        await this.prisma.bvnCheckAttempt.delete({ where: { id: attempt.id } });
        throw this.unavailable();
      }
      if (e.kind === 'identity_refused' || e.kind === 'validation') {
        await this.settle(attempt.id, 'refused');
        throw new MoneyError('bvn_not_confirmed', BVN_NOT_CONFIRMED_MESSAGE, {
          checksLeft: this.left(attempt.used),
        });
      }
      await this.settle(attempt.id, 'unavailable');
      throw this.unavailable();
    }

    // A14: the BVN's phone must be the account's. A BVN record without a
    // phone cannot match, so it is refused the same way. The BVN's phone
    // itself is never stored, logged or answered, in any form.
    const bvnPhone = toFintavaLocalPhone(identity.phone ?? '');
    if (bvnPhone !== ownPhone) {
      await this.settle(attempt.id, 'phone_mismatch');
      throw new MoneyError('bvn_phone_mismatch', BVN_PHONE_MISMATCH_MESSAGE, {
        checksLeft: this.left(attempt.used),
      });
    }

    const verifiedAt = new Date();
    // The BVN name as keyed hashes of its words, for the payout account's
    // "matches your BVN" (WALLET-14). Replaced with every passed check, so
    // it always belongs to the check beside it; never the name itself.
    const nameKeys = bvnNameKeys(identity, (word) =>
      this.hasher.hash('name', word),
    );
    const fields = {
      bvnHash,
      bvnLast4,
      bvnVerifiedAt: verifiedAt,
      ninHash,
      ninLast4,
      verifiedPhone: `+234${ownPhone.slice(1)}`,
      bvnNameKeys: nameKeys ? { ...nameKeys } : Prisma.DbNull,
    };
    const [row] = await this.prisma.$transaction([
      this.prisma.walletIdentity.upsert({
        where: { wawuUserId },
        create: { wawuUserId, ...fields },
        update: fields,
        select: {
          bvnLast4: true,
          bvnVerifiedAt: true,
          ninLast4: true,
          occupation: true,
        },
      }),
      this.prisma.bvnCheckAttempt.update({
        where: { id: attempt.id },
        data: { outcome: 'verified' },
      }),
    ]);
    return {
      identity: this.toView(row, this.left(attempt.used)),
      prefill: bvnPrefill(identity),
    };
  }

  async setOccupation(
    wawuUserId: string,
    occupation: string,
  ): Promise<WalletIdentityView> {
    const current = await this.row(wawuUserId);
    if (!current?.bvnVerifiedAt) {
      throw new MoneyError('bvn_not_checked', BVN_NOT_CHECKED_MESSAGE);
    }
    const row = await this.prisma.walletIdentity.update({
      where: { wawuUserId },
      data: { occupation },
      select: {
        bvnLast4: true,
        bvnVerifiedAt: true,
        ninLast4: true,
        occupation: true,
      },
    });
    return this.toView(row, this.left(await this.checksUsed(wawuUserId)));
  }

  /**
   * For account opening (MONEY-12), which takes the BVN and NIN again from
   * the app: true only when both are the ones this person's passed check
   * was run with. The NIN is required here; a step sent only the BVN uses
   * checkedBvn, so no caller can skip the NIN by passing nothing.
   */
  async matchesCheckedIdentity(
    wawuUserId: string,
    bvn: string,
    nin: string,
  ): Promise<boolean> {
    return (await this.checkedIdentity(wawuUserId, bvn, nin)) !== null;
  }

  /**
   * For account opening (MONEY-12): this person's passed BVN check, read
   * ONCE, when both the BVN and the NIN are the ones it was run with, with
   * the phone it proved; otherwise null. The caller ties everything after
   * it (the selfie that must have matched, the opening it claims) to the
   * check it gets back (its time and keyed hash), never to a second read of
   * "the current check", which a check passing meanwhile could change
   * (KYC-02 round 2, finding 3). The NIN is required.
   */
  async checkedIdentity(
    wawuUserId: string,
    bvn: string,
    nin: string,
  ): Promise<CheckedIdentity | null> {
    if (!this.hasher.configured) return null;
    const row = await this.prisma.walletIdentity.findUnique({
      where: { wawuUserId },
      select: {
        bvnHash: true,
        ninHash: true,
        bvnVerifiedAt: true,
        verifiedPhone: true,
      },
    });
    if (
      !row?.bvnVerifiedAt ||
      !row.bvnHash ||
      !row.verifiedPhone ||
      row.bvnHash !== this.hasher.hash('bvn', bvn) ||
      row.ninHash !== this.hasher.hash('nin', nin)
    ) {
      return null;
    }
    return {
      verifiedAt: row.bvnVerifiedAt,
      bvnHash: row.bvnHash,
      verifiedPhone: row.verifiedPhone,
    };
  }

  /**
   * For KYC-02's selfie match, which Fintava runs on the BVN alone: this
   * person's passed BVN check, read once, when `bvn` is the BVN it was run
   * with; otherwise null. The caller ties what it does to the check it gets
   * back (its time and keyed hash), not to whatever check is current later.
   */
  async checkedBvn(
    wawuUserId: string,
    bvn: string,
  ): Promise<PassedBvnCheck | null> {
    if (!this.hasher.configured) return null;
    const check = await this.currentBvnCheck(wawuUserId);
    return check && check.bvnHash === this.hasher.hash('bvn', bvn)
      ? check
      : null;
  }

  /**
   * This person's passed BVN check as it stands now (when it passed, and the
   * BVN's keyed hash), or null. A selfie match counts only for the check it
   * was compared against (KYC-02).
   */
  async currentBvnCheck(wawuUserId: string): Promise<PassedBvnCheck | null> {
    const row = await this.prisma.walletIdentity.findUnique({
      where: { wawuUserId },
      select: { bvnHash: true, bvnVerifiedAt: true },
    });
    return row?.bvnVerifiedAt && row.bvnHash
      ? { verifiedAt: row.bvnVerifiedAt, bvnHash: row.bvnHash }
      : null;
  }

  // -------------------------------------------------------------------------

  private row(wawuUserId: string): Promise<IdentityRow | null> {
    return this.prisma.walletIdentity.findUnique({
      where: { wawuUserId },
      select: {
        bvnLast4: true,
        bvnVerifiedAt: true,
        ninLast4: true,
        occupation: true,
      },
    });
  }

  private toView(
    row: IdentityRow | null,
    checksLeft: number,
  ): WalletIdentityView {
    return {
      bvn:
        row?.bvnVerifiedAt && row.bvnLast4
          ? { last4: row.bvnLast4, verifiedAt: row.bvnVerifiedAt.toISOString() }
          : null,
      ninLast4: row?.bvnVerifiedAt ? row.ninLast4 : null,
      occupation: row?.occupation ?? null,
      checksLeft,
    };
  }

  private since(): Date {
    return new Date(Date.now() - BVN_CHECK_WINDOW_MS);
  }

  private checksUsed(wawuUserId: string): Promise<number> {
    return this.prisma.bvnCheckAttempt.count({
      where: { wawuUserId, createdAt: { gt: this.since() } },
    });
  }

  private left(used: number): number {
    return Math.max(0, this.hasher.checksPerDay - used);
  }

  /** BvnCheckAttempt, as the shared daily limit counts it. */
  private readonly bvnLedger: DailyAttemptLedger = {
    create: async (wawuUserId) =>
      (
        await this.prisma.bvnCheckAttempt.create({
          data: { wawuUserId },
          select: { id: true },
        })
      ).id,
    count: (wawuUserId, since) =>
      this.prisma.bvnCheckAttempt.count({
        where: { wawuUserId, createdAt: { gt: since } },
      }),
    remove: async (id) => {
      await this.prisma.bvnCheckAttempt.delete({ where: { id } });
    },
    oldestSince: async (wawuUserId, since) =>
      (
        await this.prisma.bvnCheckAttempt.findFirst({
          where: { wawuUserId, createdAt: { gt: since } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
      )?.createdAt ?? null,
  };

  /** Takes one of today's BVN checks before Fintava is asked (reserveDailyAttempt). */
  private reserve(wawuUserId: string): Promise<{ id: string; used: number }> {
    return reserveDailyAttempt(
      this.bvnLedger,
      wawuUserId,
      this.hasher.checksPerDay,
      (retryAfterSeconds) =>
        new MoneyError('identity_checks_exhausted', CHECKS_EXHAUSTED_MESSAGE, {
          retryAfterSeconds,
        }),
    );
  }

  private async settle(id: string, outcome: string): Promise<void> {
    try {
      await this.prisma.bvnCheckAttempt.update({
        where: { id },
        data: { outcome },
      });
    } catch {
      // The row still counts toward the limit as `pending`, which is the
      // safe side; the refusal the caller is about to get matters more.
      this.logger.warn('BVN check: could not record the outcome of a check');
    }
  }

  private unavailable(): HttpException {
    return new MoneyError(
      'provider_unreachable',
      IDENTITY_UNAVAILABLE_MESSAGE,
      {
        retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
      },
    );
  }
}
