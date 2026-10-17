import {
  amountNeeded,
  backoffMs,
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

  it('one waiting order per person and item; the settlement key is a valid Idempotency-Key', () => {
    expect(orderOpenKey('u1', 'tier', 'tier-founding')).toBe(
      'u1:tier:tier-founding',
    );
    const key = settleKeyOf('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it('a refused attempt rests 1, 2, 4 minutes and no longer than the cap', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(50)).toBe(TRANSFER_DEFAULTS.maxBackoffMs);
  });
});
