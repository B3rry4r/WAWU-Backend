import {
  amountNeeded,
  backoffMs,
  duePeople,
  lapsed,
  orderOpenKey,
  sameQuote,
  settleKeyOf,
  TRANSFER_DEFAULTS,
} from '../plan-transfer-order';

/**
 * The rules a bank-transfer purchase is settled by (TIER-05), without a
 * database or a provider.
 */

describe('Pay by bank transfer at checkout: the rules (TIER-05)', () => {
  it('the amount still needed is the total less the balance, and never below zero', () => {
    expect(amountNeeded(150_000, 0)).toBe(150_000);
    expect(amountNeeded(150_000, 100_000)).toBe(50_000);
    expect(amountNeeded(150_000, 150_000)).toBe(0);
    expect(amountNeeded(150_000, 900_000)).toBe(0);
  });

  it('a current quote is the confirmed one only when the price, the Bank charge total and the goods are all the same', () => {
    const order = {
      priceKobo: 100_000,
      totalKobo: 102_325,
      terms: { products: 10, days: 365 },
    };
    const same = {
      priceKobo: 100_000,
      totalKobo: 102_325,
      terms: { days: 365, products: 10 },
    };
    expect(sameQuote(order, same)).toBe(true);
    expect(sameQuote(order, { ...same, priceKobo: 110_000 })).toBe(false);
    expect(sameQuote(order, { ...same, totalKobo: 103_000 })).toBe(false);
    expect(
      sameQuote(order, { ...same, terms: { days: 365, products: 6 } }),
    ).toBe(false);
    expect(sameQuote(order, { ...same, terms: undefined })).toBe(false);
    expect(
      sameQuote({ ...order, terms: null }, { ...same, terms: undefined }),
    ).toBe(true);
    expect(sameQuote({ ...order, terms: null }, same)).toBe(false);
  });

  it('a window has lapsed at its end and not before', () => {
    const expiresAt = new Date('2026-10-20T10:00:00Z');
    expect(lapsed({ expiresAt }, new Date('2026-10-20T09:59:59Z'))).toBe(false);
    expect(lapsed({ expiresAt }, new Date('2026-10-20T10:00:00Z'))).toBe(true);
  });

  it('one waiting order per person and item; the settlement key is one a person cannot send as an Idempotency-Key', () => {
    expect(orderOpenKey('u1', 'tier', 'tier-founding')).toBe(
      'u1:tier:tier-founding',
    );
    const key = settleKeyOf('0f8fad5b-d9cb-469f-a165-70867728950e');
    // The header allows 8 to 128 letters, digits, - and _ (the money guard's
    // own rule); the settlement key holds a colon, so no request can carry it.
    const allowedHeader = /^[A-Za-z0-9_-]{8,128}$/;
    expect(key).not.toMatch(allowedHeader);
    expect(key).toContain('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(settleKeyOf('a')).not.toBe(settleKeyOf('b'));
  });

  describe('who is due', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
    const order = (
      person: string,
      createdMinutes: number,
      extra: {
        creditsSeenMinutes?: number;
        nextCheckMinutes?: number | null;
      } = {},
    ) => ({
      wawuUserId: person,
      createdAt: at(createdMinutes),
      creditsSeenAt:
        extra.creditsSeenMinutes === undefined
          ? null
          : at(extra.creditsSeenMinutes),
      nextCheckAt:
        extra.nextCheckMinutes === undefined || extra.nextCheckMinutes === null
          ? null
          : at(extra.nextCheckMinutes),
    });

    it('an order nothing woke is not due: no new credit and a recheck still ahead', () => {
      const orders = [
        order('a', -100, { nextCheckMinutes: 3 }),
        order('b', -90, { nextCheckMinutes: 4, creditsSeenMinutes: -80 }),
      ];
      expect(duePeople(orders, new Map([['b', at(-80)]]), now)).toEqual([]);
    });

    it('a credit newer than what the order saw, or a recheck that came, makes it due', () => {
      const orders = [
        order('a', -100, { nextCheckMinutes: 3 }),
        order('b', -90, { nextCheckMinutes: 4 }),
        order('c', -80, { nextCheckMinutes: -1 }),
      ];
      expect(duePeople(orders, new Map([['b', at(-10)]]), now)).toEqual([
        'b',
        'c',
      ]);
      // A credit the order already saw wakes nothing.
      expect(
        duePeople(
          [order('b', -90, { creditsSeenMinutes: -10, nextCheckMinutes: 4 })],
          new Map([['b', at(-10)]]),
          now,
        ),
      ).toEqual([]);
    });

    it('people a new credit may have paid for come first, then rechecks, each oldest order first', () => {
      const orders = [
        order('timer-old', -500, { nextCheckMinutes: -5 }),
        order('credit-new', -20, { nextCheckMinutes: 3 }),
        order('timer-new', -30, { nextCheckMinutes: -1 }),
        order('credit-old', -400, { nextCheckMinutes: 3 }),
      ];
      const latest = new Map([
        ['credit-new', at(-1)],
        ['credit-old', at(-2)],
      ]);
      expect(duePeople(orders, latest, now)).toEqual([
        'credit-old',
        'credit-new',
        'timer-old',
        'timer-new',
      ]);
    });

    it('a person is listed once, however many of their orders are due, in the credit class when both apply', () => {
      const orders = [
        order('a', -300, { nextCheckMinutes: -2 }),
        order('a', -200, { nextCheckMinutes: 9 }),
        order('b', -100, { nextCheckMinutes: -1 }),
      ];
      expect(duePeople(orders, new Map([['a', at(-5)]]), now)).toEqual([
        'a',
        'b',
      ]);
      expect(duePeople(orders, new Map(), now)).toEqual(['a', 'b']);
    });

    it('seventy unfunded orders ahead do not hide one that is due', () => {
      const unfunded = Array.from({ length: 70 }, (_, i) =>
        order(`u${i}`, -2000 + i, { nextCheckMinutes: 3 }),
      );
      const funded = order('funded', -10, { nextCheckMinutes: 4 });
      expect(
        duePeople([...unfunded, funded], new Map([['funded', at(-1)]]), now),
      ).toEqual(['funded']);
    });
  });

  it('a refused attempt rests 1, 2, 4 minutes and no longer than the cap', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(50)).toBe(TRANSFER_DEFAULTS.maxBackoffMs);
  });
});
