import { HttpException } from '@nestjs/common';
import {
  BALANCE_CHANGED_MESSAGE,
  insufficientAfterProviderRefusal,
  insufficientFunds,
  nairaText,
  shortfallMessage,
} from '../insufficient-funds';
import { MoneyError } from '../money-error';

/**
 * "Not enough in your wallet" (task MONEY-19): one answer, built from whole
 * kobo, never a shortfall of zero or less, never a float.
 */

const reasonOf = (e: MoneyError) =>
  (e.getResponse() as { reason: Record<string, unknown> }).reason;

describe('insufficientFunds (MONEY-19)', () => {
  it('says how much short in figures and in a sentence: ₦500 against ₦1,023.25 is ₦523.25 short', () => {
    const e = insufficientFunds(50_000, 102_325);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(402);
    expect(e.code).toBe('insufficient_funds');
    expect(reasonOf(e)).toEqual({
      code: 'insufficient_funds',
      message: 'You need ₦523.25 more in your wallet.',
      balanceKobo: 50_000,
      totalKobo: 102_325,
      shortfallKobo: 52_325,
    });
  });

  it.each([
    [0, 1, 1, '₦0.01'],
    [102_324, 102_325, 1, '₦0.01'],
    [0, 100, 100, '₦1.00'],
    [120_000, 252_325, 132_325, '₦1,323.25'],
    [90_000, 150_000, 60_000, '₦600.00'],
    [0, 123_456_789, 123_456_789, '₦1,234,567.89'],
  ])(
    'a balance of %i against %i kobo is %i kobo short, written %s',
    (balance, total, shortfall, text) => {
      const e = insufficientFunds(balance, total);
      expect(reasonOf(e)).toMatchObject({ shortfallKobo: shortfall });
      expect(shortfallMessage(shortfall)).toBe(
        `You need ${text} more in your wallet.`,
      );
      expect(e.message).toBe(`You need ${text} more in your wallet.`);
    },
  );

  it('shows a negative balance as it is (the shortfall is the whole gap)', () => {
    expect(reasonOf(insufficientFunds(-500, 1_000))).toMatchObject({
      balanceKobo: -500,
      shortfallKobo: 1_500,
    });
  });

  it.each([
    ['a balance that covers the total', 102_325, 102_325],
    ['a balance above the total', 200_000, 102_325],
    ['a fractional balance', 100.5, 102_325],
    ['a fractional total', 100, 102_325.5],
    ['a balance that is not a number', Number.NaN, 102_325],
    ['a total that is not safe', 0, Number.MAX_SAFE_INTEGER + 2],
  ])('refuses to build an answer for %s (never "₦0.00 more")', (_n, b, t) => {
    expect(() => insufficientFunds(b, t)).toThrow(RangeError);
  });

  it('is plain text a person can read: no em-dash, no provider name', () => {
    const text =
      insufficientFunds(1, 102_325).message + BALANCE_CHANGED_MESSAGE;
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/fintava|nuvion|flutterwave/i);
  });
});

describe('insufficientAfterProviderRefusal (MONEY-19, lead ruling D3)', () => {
  it('a fresh read below the total is a real shortfall', () => {
    expect(reasonOf(insufficientAfterProviderRefusal(50_000, 102_325))).toEqual(
      {
        code: 'insufficient_funds',
        message: 'You need ₦523.25 more in your wallet.',
        balanceKobo: 50_000,
        totalKobo: 102_325,
        shortfallKobo: 52_325,
      },
    );
  });

  it.each([102_325, 500_000])(
    'a fresh read that covers the total (%i) says the balance changed and shows no shortfall',
    (fresh) => {
      const reason = reasonOf(insufficientAfterProviderRefusal(fresh, 102_325));
      expect(reason).toEqual({
        code: 'insufficient_funds',
        message: BALANCE_CHANGED_MESSAGE,
        balanceKobo: fresh,
        totalKobo: 102_325,
      });
      expect(reason).not.toHaveProperty('shortfallKobo');
    },
  );

  it('no fresh read at all says the balance changed, with the total and no balance', () => {
    const reason = reasonOf(insufficientAfterProviderRefusal(null, 102_325));
    expect(reason).toEqual({
      code: 'insufficient_funds',
      message: BALANCE_CHANGED_MESSAGE,
      totalKobo: 102_325,
    });
  });
});

describe('nairaText (MONEY-19)', () => {
  it.each([
    [0, '₦0.00'],
    [5, '₦0.05'],
    [100, '₦1.00'],
    [52_325, '₦523.25'],
    [102_325, '₦1,023.25'],
    [100_000_000, '₦1,000,000.00'],
    [Number.MAX_SAFE_INTEGER, '₦90,071,992,547,409.91'],
  ])('%i kobo is %s', (kobo, text) => {
    expect(nairaText(kobo)).toBe(text);
  });
});
