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
import { MoneyError } from '../money-error';
import type { BvnCheckDto } from './dto/identity-request.dto';
import { BVN_CHECK_WINDOW_MS, IdentityHasher } from './identity-config';
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
    const fields = {
      bvnHash,
      bvnLast4,
      bvnVerifiedAt: verifiedAt,
      ninHash,
      ninLast4,
      verifiedPhone: `+234${ownPhone.slice(1)}`,
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
   * For the steps after this one (KYC-02's selfie, MONEY-12's account
   * opening), which take the BVN and NIN again from the app: true only when
   * both are the ones this person's passed check was run with.
   */
  async matchesCheckedIdentity(
    wawuUserId: string,
    bvn: string,
    nin: string,
  ): Promise<boolean> {
    if (!this.hasher.configured) return false;
    const row = await this.prisma.walletIdentity.findUnique({
      where: { wawuUserId },
      select: { bvnHash: true, ninHash: true, bvnVerifiedAt: true },
    });
    return (
      Boolean(row?.bvnVerifiedAt) &&
      row?.bvnHash === this.hasher.hash('bvn', bvn) &&
      row?.ninHash === this.hasher.hash('nin', nin)
    );
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

  /**
   * Takes one of today's checks before Fintava is asked. The row is written
   * first and counted after, so two checks sent at the same moment cannot
   * both get past the limit: each sees the other. Over the limit, the row is
   * removed and the answer says when the oldest check in the window expires.
   */
  private async reserve(
    wawuUserId: string,
  ): Promise<{ id: string; used: number }> {
    const { id } = await this.prisma.bvnCheckAttempt.create({
      data: { wawuUserId },
      select: { id: true },
    });
    const since = this.since();
    const used = await this.prisma.bvnCheckAttempt.count({
      where: { wawuUserId, createdAt: { gt: since } },
    });
    if (used <= this.hasher.checksPerDay) return { id, used };

    await this.prisma.bvnCheckAttempt.delete({ where: { id } });
    const oldest = await this.prisma.bvnCheckAttempt.findFirst({
      where: { wawuUserId, createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const freesAt =
      (oldest?.createdAt.getTime() ?? Date.now()) + BVN_CHECK_WINDOW_MS;
    throw new MoneyError(
      'identity_checks_exhausted',
      CHECKS_EXHAUSTED_MESSAGE,
      {
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((freesAt - Date.now()) / 1000),
        ),
      },
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
