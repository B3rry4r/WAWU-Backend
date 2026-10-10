import { createHmac } from 'node:crypto';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  BVN_CHECK_WINDOW_MS,
  type DailyAttemptLedger,
  OPEN_ADDRESS_WINDOW_MS,
  reserveDailyAttempt,
  secondsUntilFree,
} from '../identity/identity-config';
import { MoneyError } from '../money-error';

/**
 * The daily limit on opening attempts that name a BVN or NIN, when a provider
 * reviews the person (NUV-02 round 2, U2; lead ruling "attempt cap"), and the
 * per-address limit beside it (round 3).
 *
 * Under Fintava the BVN check was the step that sent a BVN out, and it was
 * capped at 3 in 24 hours per person (`BVN_CHECKS_PER_DAY`,
 * `BvnCheckAttempt`). Under Nuvion that step is gone: the opening itself
 * names the BVN and NIN, so it carries the same limit, from the same setting
 * and the same ledger (a row holds only an id, the person, a time and a keyed
 * hash of the caller's address; its `outcome` is `opening`). The reservation
 * is KYC-01's own `reserveDailyAttempt`: the row is written first and counted
 * after, so tries at the same moment each see the others.
 *
 * What counts as an attempt: a request that takes the claim on a BVN (a
 * first try, a try after a refusal or a lost answer, a correction), and one
 * that tries to and finds the number held by another account. Taps that find
 * an opening already in flight, being checked or stopped send and claim
 * nothing, so they count for nothing and a double tap never burns the limit.
 *
 * Before the claim the limits are read (over either: `429`, nothing claimed).
 * After it the attempt is written; an answer that says "held by another
 * account" writes first and counts after, so a burst of probes at once learns
 * that answer at most `perDay` times, and from one address at most
 * `perAddress` times an hour.
 *
 * The address limit (round 3): the same rows, counted by the keyed hash of
 * the caller's address over a rolling hour, across every account, so one
 * place cannot sweep BVNs through many accounts. A request with no client
 * address (a call made on the server itself, not through the proxy) is not
 * limited by address; the account's own day limit still applies.
 */

/** `BvnCheckAttempt.outcome` of a row written for an opening attempt. */
export const OPENING_ATTEMPT_OUTCOME = 'opening';

export const OPENING_ATTEMPTS_EXHAUSTED_MESSAGE =
  'You have used today’s tries to open your wallet. Try again later.';

/** The 429 for an address that tried too many times: its own reason code. */
export const OPENING_ADDRESS_LIMITED_MESSAGE =
  'There have been too many tries to open a wallet from this connection. Try again later.';

/** The label the address key is derived under (HKDF, IdentityHasher.deriveKey). */
export const OPEN_ADDRESS_KEY_LABEL = 'nuvion-open-address-v1';

/** What a hasher offers the address key (a derived key; never the BVN key). */
export interface AddressKeyer {
  readonly configured: boolean;
  deriveKey(label: string): Buffer;
}

/**
 * The keyed hash of a caller's address, or null when there is none to key
 * (nothing is stored as the address itself).
 */
export function addressKeyOf(
  hasher: AddressKeyer,
  address: string | null | undefined,
): string | null {
  const a = (address ?? '').trim();
  if (a === '' || !hasher.configured) return null;
  return createHmac('sha256', hasher.deriveKey(OPEN_ADDRESS_KEY_LABEL))
    .update(a)
    .digest('hex')
    .slice(0, 32);
}

export class OpeningAttempts {
  constructor(
    private readonly prisma: Pick<PrismaService, 'bvnCheckAttempt'>,
    private readonly perDay: number,
    private readonly perAddressPerHour: number = Number.MAX_SAFE_INTEGER,
  ) {}

  private since(windowMs: number): Date {
    return new Date(Date.now() - windowMs);
  }

  /**
   * BvnCheckAttempt as KYC-01's `reserveDailyAttempt` counts it, for the
   * rows written for an opening (their `outcome`), carrying the address key
   * of the request that made them.
   */
  private ledger(addressKey: string | null): DailyAttemptLedger {
    return {
      create: async (wawuUserId) =>
        (
          await this.prisma.bvnCheckAttempt.create({
            data: {
              wawuUserId,
              outcome: OPENING_ATTEMPT_OUTCOME,
              ...(addressKey !== null ? { addressKey } : {}),
            },
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
  }

  private exhausted(retryAfterSeconds: number): MoneyError {
    return new MoneyError(
      'identity_checks_exhausted',
      OPENING_ATTEMPTS_EXHAUSTED_MESSAGE,
      { retryAfterSeconds },
    );
  }

  private addressLimited(retryAfterSeconds: number): MoneyError {
    return new MoneyError(
      'open_address_limited',
      OPENING_ADDRESS_LIMITED_MESSAGE,
      { retryAfterSeconds },
    );
  }

  /** When the person's day frees a place, or null while one is free. */
  private async personOpensAt(wawuUserId: string): Promise<Date | null> {
    const ledger = this.ledger(null);
    const since = this.since(BVN_CHECK_WINDOW_MS);
    if ((await ledger.count(wawuUserId, since)) < this.perDay) return null;
    const oldest = await ledger.oldestSince(wawuUserId, since);
    return new Date(Date.now() + secondsUntilFree(oldest) * 1000);
  }

  /** The address's tries inside the hour and the oldest of them. */
  private async addressUse(
    addressKey: string,
  ): Promise<{ used: number; oldest: Date | null }> {
    const since = this.since(OPEN_ADDRESS_WINDOW_MS);
    const [used, oldest] = await Promise.all([
      this.prisma.bvnCheckAttempt.count({
        where: { addressKey, createdAt: { gt: since } },
      }),
      this.prisma.bvnCheckAttempt.findFirst({
        where: { addressKey, createdAt: { gt: since } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return { used, oldest: oldest?.createdAt ?? null };
  }

  /** When the address's hour frees a place, or null while one is free. */
  private async addressOpensAt(addressKey: string): Promise<Date | null> {
    const { used, oldest } = await this.addressUse(addressKey);
    if (used < this.perAddressPerHour) return null;
    return new Date(
      Date.now() + secondsUntilFree(oldest, OPEN_ADDRESS_WINDOW_MS) * 1000,
    );
  }

  /**
   * When the tries open again, or null while the person (and this address)
   * have one left: the time the view's `canResubmitAt` shows, so it never
   * offers a try the server would answer with a 429 (N6).
   */
  async opensAgainAt(
    wawuUserId: string,
    addressKey: string | null = null,
  ): Promise<Date | null> {
    const person = await this.personOpensAt(wawuUserId);
    const address =
      addressKey === null ? null : await this.addressOpensAt(addressKey);
    if (person === null) return address;
    if (address === null) return person;
    return person > address ? person : address;
  }

  /**
   * Throws the 429 when today's attempts, or this address's hour, are used
   * up. Writes nothing.
   */
  async assertLeft(
    wawuUserId: string,
    addressKey: string | null = null,
  ): Promise<void> {
    const person = await this.personOpensAt(wawuUserId);
    if (person !== null) {
      throw this.exhausted(
        Math.max(1, Math.ceil((person.getTime() - Date.now()) / 1000)),
      );
    }
    if (addressKey === null) return;
    const address = await this.addressOpensAt(addressKey);
    if (address !== null) {
      throw this.addressLimited(
        Math.max(1, Math.ceil((address.getTime() - Date.now()) / 1000)),
      );
    }
  }

  /**
   * Writes one attempt. With `refuseOver`, an attempt beyond either limit (a
   * burst raced past `assertLeft`) is taken back out and the 429 is thrown:
   * the day's, by KYC-01's `reserveDailyAttempt`; the address's hour, by
   * counting after the write in the same way. Without it the attempt stands
   * (the request already holds its claim).
   */
  async spend(
    wawuUserId: string,
    refuseOver: boolean,
    addressKey: string | null = null,
  ): Promise<void> {
    const ledger = this.ledger(addressKey);
    if (!refuseOver) {
      await ledger.create(wawuUserId);
      return;
    }
    const { id } = await reserveDailyAttempt(
      ledger,
      wawuUserId,
      this.perDay,
      (retryAfterSeconds) => this.exhausted(retryAfterSeconds),
    );
    if (addressKey === null) return;
    const { used, oldest } = await this.addressUse(addressKey);
    if (used <= this.perAddressPerHour) return;
    await ledger.remove(id);
    throw this.addressLimited(secondsUntilFree(oldest, OPEN_ADDRESS_WINDOW_MS));
  }
}
