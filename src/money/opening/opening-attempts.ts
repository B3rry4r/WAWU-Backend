import { createHmac } from 'node:crypto';
import { isIPv6 } from 'node:net';
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
 * Before the claim the limits are read (over either: `429`, nothing claimed:
 * `assertLeft`, a read that only turns most refusals away early). The
 * address's hour is then held by one atomic step (`reservePlace`, round 4,
 * N12): under a lock on the address, inside one transaction, the hour's tries
 * are counted and, only when one is free, the place is written. A burst of
 * requests from one address, on one server or on several sharing the
 * database, is let through one at a time, so exactly the limit proceed. The
 * place is the try's own row (`outcome` `reserved`, which the person's day does
 * not count): `spend` makes it the try once the claim is taken, `give` takes
 * it back when the claim is not (another request of the account holds the
 * opening, or the request failed before the claim). An answer that says "held
 * by another account" keeps the place as the try and counts the person's day
 * after, so a burst of probes learns that answer at most `perDay` times, and
 * from one address at most `perAddress` times an hour.
 *
 * The address limit (round 3): the same rows, counted by the keyed hash of
 * the caller's address over a rolling hour, across every account, so one
 * place cannot sweep BVNs through many accounts. A request with no client
 * address (a call made on the server itself, not through the proxy) is not
 * limited by address; the account's own day limit still applies.
 */

/** `BvnCheckAttempt.outcome` of a row written for an opening attempt. */
export const OPENING_ATTEMPT_OUTCOME = 'opening';

/**
 * `BvnCheckAttempt.outcome` of a place held on an address for a request that
 * has not yet taken its claim (N12). The person's day does not count it.
 */
export const OPENING_PLACE_OUTCOME = 'reserved';

/** A place held on the caller's address (the row it is written as). */
export interface AddressPlace {
  readonly id: string;
}

/**
 * How long a place held for a request that has not yet taken its claim is
 * taken to be a request still in flight. A request of the same account that
 * finds one meets its own double tap: it does nothing and takes no place, as
 * the second of two taps does when the first holds the opening. A place older
 * than this belongs to a request that never finished (a server that died); it
 * is ignored here and stays counted against the address until its hour is out.
 */
export const PLACE_IN_FLIGHT_MS = 60_000;

/** What `reservePlace` found. */
export interface PlaceReservation {
  /** The place taken, or null when the request has no client address. */
  place: AddressPlace | null;
  /** Another request of this account already holds a place on this address. */
  concurrent: boolean;
}

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
 * The place an address stands for: an IPv4 address is itself, an IPv4-mapped
 * IPv6 address is its IPv4 address, and any other IPv6 address is its /64
 * (the block one connection is given, so rotating through its addresses is
 * still one place).
 */
export function addressPlaceOf(address: string): string {
  const a = address.trim().toLowerCase().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!isIPv6(a) || a.includes('.')) return a;
  const [head = '', tail = ''] = a.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === '' ? [] : tail.split(':');
  const groups = a.includes('::')
    ? [
        ...first,
        ...Array<string>(8 - first.length - last.length).fill('0'),
        ...last,
      ]
    : first;
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}/64`;
}

/**
 * The keyed hash of a caller's address (its place, `addressPlaceOf`), or
 * null when there is none to key (nothing is stored as the address itself).
 */
export function addressKeyOf(
  hasher: AddressKeyer,
  address: string | null | undefined,
): string | null {
  const a = (address ?? '').trim();
  if (a === '' || !hasher.configured) return null;
  return createHmac('sha256', hasher.deriveKey(OPEN_ADDRESS_KEY_LABEL))
    .update(addressPlaceOf(a))
    .digest('hex')
    .slice(0, 32);
}

export class OpeningAttempts {
  constructor(
    private readonly prisma: Pick<
      PrismaService,
      'bvnCheckAttempt' | '$transaction'
    >,
    private readonly perDay: number,
    private readonly perAddressPerHour: number = Number.MAX_SAFE_INTEGER,
  ) {}

  private since(windowMs: number): Date {
    return new Date(Date.now() - windowMs);
  }

  /**
   * BvnCheckAttempt as KYC-01's `reserveDailyAttempt` counts it, for the
   * rows written for an opening (their `outcome`). The person's day does not
   * count a place held on an address that has not yet become a try.
   */
  private ledger(): DailyAttemptLedger {
    const counted = { outcome: { not: OPENING_PLACE_OUTCOME } };
    return {
      create: async (wawuUserId) =>
        (
          await this.prisma.bvnCheckAttempt.create({
            data: { wawuUserId, outcome: OPENING_ATTEMPT_OUTCOME },
            select: { id: true },
          })
        ).id,
      count: (wawuUserId, since) =>
        this.prisma.bvnCheckAttempt.count({
          where: { wawuUserId, createdAt: { gt: since }, ...counted },
        }),
      remove: async (id) => {
        await this.prisma.bvnCheckAttempt.deleteMany({ where: { id } });
      },
      oldestSince: async (wawuUserId, since) =>
        (
          await this.prisma.bvnCheckAttempt.findFirst({
            where: { wawuUserId, createdAt: { gt: since }, ...counted },
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
    const ledger = this.ledger();
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
   * Takes one of the address's places for this request, atomically (N12).
   * Under a lock on the address (a transaction-scoped advisory lock, so it
   * orders requests across servers sharing the database), inside one
   * READ COMMITTED transaction: the hour's rows of the address are counted
   * and, only when the limit leaves one, the place is written. Two requests
   * therefore never both see the last free place. Over the limit it is the
   * 429 and nothing is written. `place` is null, with nothing written, when
   * the request has no client address.
   *
   * A request of the same account that finds its own earlier request still
   * holding a place on this address (`PLACE_IN_FLIGHT_MS`) is a double tap:
   * it takes no place and answers `concurrent`, so ten taps never use ten
   * places up. The caller must `spend` the place when its claim is taken, or
   * `give` it back; a place left by a server that died in between stays
   * counted against the address until its hour is out (the safe side).
   */
  async reservePlace(
    wawuUserId: string,
    addressKey: string | null,
  ): Promise<PlaceReservation> {
    if (addressKey === null) return { place: null, concurrent: false };
    const since = this.since(OPEN_ADDRESS_WINDOW_MS);
    const flying = this.since(PLACE_IN_FLIGHT_MS);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`open-address:${addressKey}`}, 0))`;
        const mine = await tx.bvnCheckAttempt.findFirst({
          where: {
            wawuUserId,
            addressKey,
            outcome: OPENING_PLACE_OUTCOME,
            createdAt: { gt: flying },
          },
          select: { id: true },
        });
        if (mine) return { place: null, concurrent: true };
        const where = { addressKey, createdAt: { gt: since } };
        const used = await tx.bvnCheckAttempt.count({ where });
        if (used >= this.perAddressPerHour) {
          const oldest = await tx.bvnCheckAttempt.findFirst({
            where,
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          });
          throw this.addressLimited(
            secondsUntilFree(oldest?.createdAt ?? null, OPEN_ADDRESS_WINDOW_MS),
          );
        }
        const row = await tx.bvnCheckAttempt.create({
          data: { wawuUserId, outcome: OPENING_PLACE_OUTCOME, addressKey },
          select: { id: true },
        });
        return { place: { id: row.id }, concurrent: false };
      },
      { maxWait: 10_000, timeout: 15_000 },
    );
  }

  /** Gives a place back (the claim was not taken, or the request failed). */
  async give(place: AddressPlace | null): Promise<void> {
    if (place === null) return;
    await this.prisma.bvnCheckAttempt.deleteMany({ where: { id: place.id } });
  }

  /**
   * Writes one attempt: the place held for it (`reservePlace`) becomes the
   * try, or, for a request with no client address (`place` null), a row is
   * written. With `refuseOver`, an attempt beyond the day's limit (a burst
   * raced past `assertLeft`) is taken back out and the 429 is thrown, by
   * KYC-01's `reserveDailyAttempt` (the row first, the count after). Without
   * it the attempt stands (the request already holds its claim).
   */
  async spend(
    wawuUserId: string,
    refuseOver: boolean,
    place: AddressPlace | null = null,
  ): Promise<void> {
    const ledger: DailyAttemptLedger =
      place === null
        ? this.ledger()
        : {
            ...this.ledger(),
            create: async () => {
              await this.prisma.bvnCheckAttempt.updateMany({
                where: { id: place.id },
                data: { outcome: OPENING_ATTEMPT_OUTCOME },
              });
              return place.id;
            },
          };
    if (!refuseOver) {
      await ledger.create(wawuUserId);
      return;
    }
    await reserveDailyAttempt(
      ledger,
      wawuUserId,
      this.perDay,
      (retryAfterSeconds) => this.exhausted(retryAfterSeconds),
    );
  }
}
