import { randomUUID } from 'node:crypto';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../../wallet-provider/wallet-provider-limit';
import {
  BELOW_MINIMUM_WORDS,
  CASH_OUT_HOLD_TITLE,
  CASH_OUT_NARRATION,
  cashForPoints,
  CONVERSION_WORDS,
  conversionReference,
  CURRENCY_WORDS,
  pointsWithinCap,
  provedNothingMoved,
  TOO_MUCH_WORDS,
} from '../points-convert-rules';

describe('points to cash: the rules that need no database (POINTS-04)', () => {
  describe('the cash for some points', () => {
    it.each([
      [1000, 50_000, 50_000n],
      [1, 50_000, 50n],
      [777, 333, 258n], // 258.741 kobo, rounded down
      [999, 1, 0n],
      [1000, 1, 1n],
      [2_147_483_647, 50_000, 107_374_182n * 1000n + 350n],
    ])('%i points at %i kobo per 1,000 is %s kobo', (points, rate, kobo) => {
      expect(cashForPoints(points, rate)).toBe(kobo);
    });

    it('never pays more than the rate says, and never loses more than a kobo', () => {
      for (const rate of [1, 7, 333, 50_000, 99_999]) {
        for (const points of [1, 2, 9, 10, 99, 250, 999, 1000, 1001, 12_345]) {
          const cash = cashForPoints(points, rate);
          const exact = BigInt(points) * BigInt(rate);
          expect(cash * 1000n).toBeLessThanOrEqual(exact);
          expect(exact - cash * 1000n).toBeLessThan(1000n);
        }
      }
    });
  });

  describe('the most points a cap allows', () => {
    it('is the largest number of points whose cash is within the cap', () => {
      for (const rate of [1, 3, 333, 1000, 50_000]) {
        for (const cap of [1, 2, 50, 999, 1000, 100_000]) {
          const most = pointsWithinCap(cap, rate)!;
          expect(cashForPoints(most, rate)).toBeLessThanOrEqual(BigInt(cap));
          expect(cashForPoints(most + 1, rate)).toBeGreaterThan(BigInt(cap));
        }
      }
    });

    it('is none when there is no cap', () => {
      expect(pointsWithinCap(null, 50_000)).toBeNull();
    });
  });

  it("names the move for the provider by the conversion, inside Nuvion's 64 characters", () => {
    const id = randomUUID();
    expect(conversionReference(id)).toBe(`wawu-pts-${id}`);
    expect(conversionReference(id).length).toBeLessThanOrEqual(64);
  });

  describe('what a refusal proves', () => {
    const error = (over: Record<string, unknown>) =>
      new WalletProviderError({
        kind: 'refused',
        provider: 'nuvion',
        operation: 'book transfer',
        ...over,
      });

    it('a refusal that says nothing exists, and a request that never left, prove nothing moved', () => {
      expect(provedNothingMoved(error({ recordMayExist: false }))).toBe(true);
      expect(
        provedNothingMoved(
          error({
            kind: 'outcome_unknown',
            recordMayExist: true,
            requestNotSent: true,
          }),
        ),
      ).toBe(true);
      expect(
        provedNothingMoved(
          new WalletProviderLimitError({
            provider: 'nuvion',
            operation: 'book transfer',
            limit: 'daily',
          }),
        ),
      ).toBe(true);
    });

    it('a lost answer, an unfinished transfer, a repeated reference and anything that is not a provider error prove nothing', () => {
      for (const kind of [
        'outcome_unknown',
        'not_confirmed',
        'duplicate_reference',
      ] as const) {
        expect(provedNothingMoved(error({ kind }))).toBe(false);
      }
      expect(provedNothingMoved(error({ recordMayExist: true }))).toBe(false);
      expect(provedNothingMoved(new Error('boom'))).toBe(false);
      expect(provedNothingMoved(undefined)).toBe(false);
      expect(provedNothingMoved('refused')).toBe(false);
    });
  });

  it('says everything in plain words: no em-dash, no provider name, no figure of the plan', () => {
    const said = [
      CONVERSION_WORDS.pending,
      CONVERSION_WORDS.review,
      ...Object.values(CONVERSION_WORDS.cancelled),
      BELOW_MINIMUM_WORDS,
      CURRENCY_WORDS,
      TOO_MUCH_WORDS,
      CASH_OUT_HOLD_TITLE,
      CASH_OUT_NARRATION,
    ];
    for (const text of said) {
      expect(text).not.toContain('—');
      expect(text.toLowerCase()).not.toMatch(/fintava|nuvion|loma/);
      expect(text).not.toMatch(/[0-9]/);
    }
  });
});
