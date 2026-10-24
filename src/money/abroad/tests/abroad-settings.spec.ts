import { providerFeeFor, readProviderFees } from '../abroad-settings';

describe("the partner's fee per corridor (NUV-11 round 1, R-10)", () => {
  const fees = readProviderFees({
    ABROAD_PROVIDER_FEE_GHS_MOBILE_MONEY: '150',
    ABROAD_PROVIDER_FEE_AUD_BANK_FROM_NGN: '0',
    ABROAD_PROVIDER_FEE_AUD_BANK: '100',
    ABROAD_PROVIDER_FEE_KES_BANK: ' 250 ',
    UNRELATED: 'x',
    ABROAD_PROVIDER_FEE_TZS_BANK: '',
  });

  it('the plain figure is the dollar one; a source with its own figure uses it; any other source is not estimated', () => {
    expect(providerFeeFor(fees, 'USD', 'GHS', 'mobile_money')).toBe(150);
    expect(providerFeeFor(fees, 'NGN', 'AUD', 'bank')).toBe(0);
    expect(providerFeeFor(fees, 'USD', 'AUD', 'bank')).toBe(100);
    expect(providerFeeFor(fees, 'GBP', 'AUD', 'bank')).toBeNull();
    expect(providerFeeFor(fees, 'NGN', 'GHS', 'mobile_money')).toBeNull();
    expect(providerFeeFor(fees, 'USD', 'GHS', 'bank')).toBeNull();
    expect(providerFeeFor(fees, 'USD', 'KES', 'bank')).toBe(250);
    expect(providerFeeFor(fees, 'USD', 'TZS', 'bank')).toBeNull();
  });

  it('a setting that is set and wrong stops the server at boot, naming it', () => {
    expect(() =>
      readProviderFees({ ABROAD_PROVIDER_FEE_GHS_MOBILE_MONEY: '1.50' }),
    ).toThrow(/ABROAD_PROVIDER_FEE_GHS_MOBILE_MONEY must be a whole number/);
    expect(() =>
      readProviderFees({ ABROAD_PROVIDER_FEE_GHS_MOBILE_MONEY: '-5' }),
    ).toThrow(/whole number/);
    expect(() =>
      readProviderFees({ ABROAD_PROVIDER_FEE_GHS_WALLET: '5' }),
    ).toThrow(/ABROAD_PROVIDER_FEE_GHS_WALLET is not a setting of this kind/);
    expect(() =>
      readProviderFees({ ABROAD_PROVIDER_FEE_ghs_bank: '5' }),
    ).toThrow(/not a setting of this kind/);
  });
});
