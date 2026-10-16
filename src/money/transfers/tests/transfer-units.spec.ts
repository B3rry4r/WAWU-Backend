import { splitCharge } from '../transfer-figures';

/**
 * How the one charge the provider reports on a send is split between its own
 * and WAWU's fee (WALLET-07): always adds up to what really left the wallet.
 */
describe('splitCharge', () => {
  const quoted = { providerFeeKobo: 2325, wawuFeeKobo: 1000 };

  it('keeps the quoted split when the provider took what was quoted', () => {
    expect(splitCharge(quoted, 3325)).toEqual(quoted);
  });

  it("gives an excess to the provider, and keeps WAWU's fee as quoted", () => {
    expect(splitCharge(quoted, 5000)).toEqual({
      providerFeeKobo: 4000,
      wawuFeeKobo: 1000,
    });
  });

  it("pays the provider's charge first and leaves WAWU's fee what is left when less was taken", () => {
    expect(splitCharge(quoted, 2325)).toEqual({
      providerFeeKobo: 2325,
      wawuFeeKobo: 0,
    });
    expect(splitCharge(quoted, 3000)).toEqual({
      providerFeeKobo: 2325,
      wawuFeeKobo: 675,
    });
    expect(splitCharge(quoted, 1000)).toEqual({
      providerFeeKobo: 1000,
      wawuFeeKobo: 0,
    });
    expect(splitCharge(quoted, 0)).toEqual({
      providerFeeKobo: 0,
      wawuFeeKobo: 0,
    });
  });

  it('always adds up to the charge, for every charge from 0 to twice the quote', () => {
    for (let real = 0; real <= 6650; real += 1) {
      const s = splitCharge(quoted, real);
      expect(s.providerFeeKobo + s.wawuFeeKobo).toBe(real);
      expect(s.providerFeeKobo).toBeGreaterThanOrEqual(0);
      expect(s.wawuFeeKobo).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses a charge that is not a whole number of kobo, or is negative', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => splitCharge(quoted, bad)).toThrow(RangeError);
    }
  });
});
