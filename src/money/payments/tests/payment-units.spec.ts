import { fintavaConfig } from '../../../../test/fintava/fintava-double';
import { HELD_PAYMENT_KINDS } from '../../dto/money-enums';
import { FeeConfigError } from '../../fees/fee-config';
import { bodyFingerprint, canonicalJson } from '../idempotency';
import { PayableRegistry } from '../payable-registry';
import {
  DEFAULT_IDEMPOTENCY_KEY_HOURS,
  PaymentSettings,
  splitPrice,
} from '../payment-config';
import { completedFigures, joinNotes } from '../payment-figures';
import {
  nairaText,
  nextCheckDelayMs,
  successBody,
} from '../wallet-payment.service';

/** Pay from wallet's pure parts (task MONEY-17). */
describe('MONEY-17 units', () => {
  describe('splitPrice (R-5: 85/15 of the price, R-10)', () => {
    it.each([
      [100_000, 85_000, 15_000],
      [200_000, 170_000, 30_000],
      [250_000, 212_500, 37_500],
      [99_999, 84_999, 15_000],
      [1, 0, 1],
      [7, 5, 2],
      [1_000_000_000, 850_000_000, 150_000_000],
    ])('%i kobo: payee %i, WAWU %i', (price, payee, wawu) => {
      expect(splitPrice(price, true)).toEqual({
        payeeShareKobo: payee,
        wawuShareKobo: wawu,
      });
    });

    it('the two shares always add up to the price, and the payee never gets more than 85%', () => {
      for (let price = 1; price <= 20_000; price += 1) {
        const s = splitPrice(price, true);
        expect(s.payeeShareKobo + s.wawuShareKobo).toBe(price);
        expect(s.payeeShareKobo * 100).toBeLessThanOrEqual(price * 85);
        expect((s.payeeShareKobo + 1) * 100).toBeGreaterThan(price * 85);
      }
    });

    it("with no payee the whole price is WAWU's", () => {
      expect(splitPrice(100_000, false)).toEqual({
        payeeShareKobo: 0,
        wawuShareKobo: 100_000,
      });
    });

    it('matches a bigint reference for every price a payment can carry (the 85% needs no float)', () => {
      for (let price = 1; price <= 300_000; price += 1) {
        const share = Number((BigInt(price) * 8500n) / 10_000n);
        expect(splitPrice(price, true).payeeShareKobo).toBe(share);
      }
      // 140 kobo: 85% is exactly 119.
      expect(splitPrice(140, true)).toEqual({
        payeeShareKobo: 119,
        wawuShareKobo: 21,
      });
    });

    it('refuses a price that is not a positive whole kobo', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
        expect(() => splitPrice(bad, true)).toThrow(RangeError);
      }
    });
  });

  describe('nextCheckDelayMs (the backoff of a payment still unknown, R7)', () => {
    const MIN = 60_000;

    it('doubles from a minute and stops at an hour: 1, 2, 4, 8, 16, 32, 60, 60 ...', () => {
      expect(
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 20, 1000].map((n) => nextCheckDelayMs(n)),
      ).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60].map((m) => m * MIN));
    });

    it('never asks again sooner than a minute or later than an hour, for any count', () => {
      for (let n = 0; n <= 200; n += 1) {
        const d = nextCheckDelayMs(n);
        expect(d).toBeGreaterThanOrEqual(MIN);
        expect(d).toBeLessThanOrEqual(60 * MIN);
      }
    });
  });

  describe('canonical JSON and the fingerprint', () => {
    it('sorts keys at every depth and drops undefined', () => {
      expect(
        canonicalJson({
          b: 1,
          a: { d: [3, { z: 1, y: 2 }], c: null },
          u: undefined,
        }),
      ).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    });

    it('the same body in another key order is the same fingerprint; any other value is not', () => {
      const a = {
        kind: 'tip',
        targetId: 'x',
        amountKobo: 100,
        expectedTotalKobo: 2425,
      };
      const b = {
        expectedTotalKobo: 2425,
        amountKobo: 100,
        targetId: 'x',
        kind: 'tip',
      };
      expect(bodyFingerprint(a)).toBe(bodyFingerprint(b));
      expect(bodyFingerprint(a)).not.toBe(
        bodyFingerprint({ ...a, amountKobo: 101 }),
      );
      expect(bodyFingerprint(a)).not.toBe(
        bodyFingerprint({ ...a, amountKobo: '100' }),
      );
      expect(bodyFingerprint(undefined)).toBe(bodyFingerprint(null));
    });
  });

  describe('nairaText', () => {
    it.each([
      [0, '₦0.00'],
      [5, '₦0.05'],
      [52_325, '₦523.25'],
      [132_325, '₦1,323.25'],
      [100_000_000_00, '₦100,000,000.00'],
    ])('%i kobo is %s', (kobo, text) => {
      expect(nairaText(kobo)).toBe(text);
    });
  });

  it('a replayed body is the envelope ResponseInterceptor sends', () => {
    expect(successBody({ id: 'x' })).toBe(
      '{"statusCode":200,"message":"OK","data":{"id":"x"}}',
    );
  });

  describe('PayableRegistry', () => {
    it('refuses held kinds (MONEY-18) and a second handler for a kind', () => {
      const r = new PayableRegistry();
      for (const kind of HELD_PAYMENT_KINDS) {
        expect(() =>
          r.register({ kind, resolve: () => Promise.reject(new Error('x')) }),
        ).toThrow(/MONEY-18/);
      }
      r.register({
        kind: 'tip',
        resolve: () => Promise.reject(new Error('x')),
      });
      expect(() =>
        r.register({
          kind: 'tip',
          resolve: () => Promise.reject(new Error('x')),
        }),
      ).toThrow(/already/);
      expect(r.kinds()).toEqual(['tip']);
      expect(r.get('content_unlock')).toBeNull();
    });
  });

  describe('IDEMPOTENCY_KEY_HOURS', () => {
    it('defaults to the provisional figure and accepts 24 to 720', () => {
      expect(new PaymentSettings(fintavaConfig({})).idempotencyKeyHours).toBe(
        DEFAULT_IDEMPOTENCY_KEY_HOURS,
      );
      expect(
        new PaymentSettings(fintavaConfig({ IDEMPOTENCY_KEY_HOURS: '24' }))
          .idempotencyKeyHours,
      ).toBe(24);
    });

    it.each(['23', '721', '1.5', 'two', '-1'])('stops the app on %s', (v) => {
      expect(
        () => new PaymentSettings(fintavaConfig({ IDEMPOTENCY_KEY_HOURS: v })),
      ).toThrow(FeeConfigError);
    });
  });
  describe("completedFigures (R6-1: the provider's own record decides what a payment completes at)", () => {
    const quoted = { providerFeeKobo: 1_500n, totalKobo: 101_500n };

    it('a record that carries no charge leaves the quote standing', () => {
      expect(
        completedFigures(
          quoted,
          { amountKobo: 100_000n, feeKobo: null, totalKobo: null },
          'Nuvion',
        ),
      ).toEqual({
        verdict: 'as_quoted',
        feeKobo: 1_500n,
        totalKobo: 101_500n,
        note: null,
      });
    });

    it('the quoted charge is as_quoted whether the record gives the fee, the total or both', () => {
      for (const record of [
        { amountKobo: 100_000n, feeKobo: 1_500n, totalKobo: null },
        { amountKobo: 100_000n, feeKobo: null, totalKobo: 101_500n },
        { amountKobo: 100_000n, feeKobo: 1_500n, totalKobo: 101_500n },
      ]) {
        expect(completedFigures(quoted, record, 'Nuvion').verdict).toBe(
          'as_quoted',
        );
      }
    });

    it('a higher charge is above, a lower one below, each with both figures in its note and the real ones returned', () => {
      const above = completedFigures(
        quoted,
        { amountKobo: 100_000n, feeKobo: 2_200n, totalKobo: null },
        'Nuvion',
      );
      expect(above).toEqual({
        verdict: 'above',
        feeKobo: 2_200n,
        totalKobo: 102_200n,
        note: 'debit above the quote: Nuvion took 102200 kobo (fee 2200), quoted 101500 kobo (fee 1500)',
      });
      const below = completedFigures(
        quoted,
        { amountKobo: 100_000n, feeKobo: null, totalKobo: 101_000n },
        'Nuvion',
      );
      expect(below).toEqual({
        verdict: 'below',
        feeKobo: 1_000n,
        totalKobo: 101_000n,
        note: 'debit differs from the quote: Nuvion took 101000 kobo (fee 1000), quoted 101500 kobo (fee 1500)',
      });
    });

    it('one kobo either side of the quote is still above or below, never as_quoted', () => {
      const one = (feeKobo: bigint) =>
        completedFigures(
          quoted,
          { amountKobo: 100_000n, feeKobo, totalKobo: null },
          'Fintava',
        ).verdict;
      expect(one(1_501n)).toBe('above');
      expect(one(1_499n)).toBe('below');
      expect(one(0n)).toBe('below');
    });
  });

  describe('joinNotes (a discrepancy never says the same thing twice)', () => {
    it('joins what is there, in order, once each', () => {
      expect(joinNotes(null, 'a', undefined, 'b', 'a', '', 'c')).toBe(
        'a; b; c',
      );
      expect(joinNotes('a; b', 'b', 'c')).toBe('a; b; c');
      expect(joinNotes(null, undefined, '')).toBeNull();
    });

    it('a note that only contains another as part of a longer one is still kept', () => {
      expect(joinNotes('debit above the quote: x', 'above the quote')).toBe(
        'debit above the quote: x; above the quote',
      );
    });

    it('is at most 1000 characters', () => {
      expect(joinNotes('x'.repeat(2_000))!.length).toBe(1_000);
    });
  });
});
