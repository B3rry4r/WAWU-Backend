import { ConfigService } from '@nestjs/config';
import type { WalletProviderName } from '../../../wallet-provider/wallet-provider.interface';
import { FEE_CONFIG_KEYS, FeeConfigError, FeeSettings } from '../fee-config';
import { FeeQuoteService } from '../fee-quote.service';
import { NUVION_FEE_CONFIG_KEYS } from '../nuvion-fee-config';
import {
  ARRIVAL_CONFIG_KEYS,
  arrivalMinutesSetting,
  readTransferTiming,
  transferInOf,
} from '../transfer-timing';

/**
 * FIX-109: the two facts the wallet screens say in a line, as settings the
 * Hub serves (G-WALLET-05-2, -3, G-FIX-68-1, -2). No database, no HTTP: the
 * quote reads the running provider's name and its settings, and asks nobody.
 * The figures below are the spec's own; the app writes none.
 */

const USER = '0f0a5a3e-6a35-4c35-9a1b-6a8f2f3f9a01';
const A = ARRIVAL_CONFIG_KEYS;
const N = NUVION_FEE_CONFIG_KEYS;
const NUVION_SET: Record<string, string> = {
  [N.bookTransfer]: '1234',
  [N.bankPayout]: '3100',
  [N.inflow]: '0',
};

function service(
  provider: WalletProviderName,
  env: Record<string, string> = {},
): FeeQuoteService {
  const config = new ConfigService({
    [FEE_CONFIG_KEYS.quoteKey]: 'n'.repeat(40),
    ...env,
  });
  return new FeeQuoteService(
    new FeeSettings(config),
    { name: provider },
    config,
  );
}

describe('FIX-109: how long a bank transfer takes, and what a transfer in costs', () => {
  describe('reading the arrival settings', () => {
    it('empty is unset; whole minutes from 1 to a day are a figure', () => {
      for (const raw of [undefined, null, '', '  ']) {
        expect(arrivalMinutesSetting(raw, A.bankOut)).toBeNull();
      }
      expect(arrivalMinutesSetting('7', A.bankOut)).toBe(7);
      expect(arrivalMinutesSetting(' 1440 ', A.bankOut)).toBe(1440);
    });

    it('a value that is set but unusable stops the app, naming the setting', () => {
      for (const raw of ['0', '-5', '1441', '2.5', '1e2', 'soon', '5 min']) {
        expect(() => arrivalMinutesSetting(raw, A.bankIn)).toThrow(
          FeeConfigError,
        );
        expect(() => arrivalMinutesSetting(raw, A.bankIn)).toThrow(A.bankIn);
      }
    });

    it('reads both through one getter, each on its own', () => {
      const env: Record<string, string> = { [A.bankOut]: '10' };
      expect(readTransferTiming((k) => env[k])).toEqual({
        bankOutMinutes: 10,
        bankInMinutes: null,
      });
    });
  });

  describe('a transfer in (WalletView.transferIn)', () => {
    const timing = (bankInMinutes: number | null) => ({
      bankOutMinutes: null,
      bankInMinutes,
    });

    it('Nuvion with a flat inflow of 0 says free, and nothing else it does not know', () => {
      expect(
        transferInOf('nuvion', timing(null), (k) => NUVION_SET[k]),
      ).toEqual({
        feeKobo: 0,
      });
    });

    it('a flat figure above 0 is that figure; bands that all charge the same are one figure', () => {
      expect(transferInOf('nuvion', timing(null), () => '2500')).toEqual({
        feeKobo: 2500,
      });
      expect(
        transferInOf('nuvion', timing(null), (k) =>
          k === N.inflow ? '0:500,100000:500' : '1',
        ),
      ).toEqual({ feeKobo: 500 });
    });

    it('bands that differ name no single figure, so none is served', () => {
      expect(
        transferInOf('nuvion', timing(null), (k) =>
          k === N.inflow ? '0:0,100000:500' : '1',
        ),
      ).toBeNull();
      expect(
        transferInOf('nuvion', timing(12), (k) =>
          k === N.inflow ? '0:0,100000:500' : '1',
        ),
      ).toEqual({ arrivalMinutes: 12 });
    });

    it('an unset inflow serves no fee, and Fintava (no inflow charge) serves none', () => {
      expect(transferInOf('nuvion', timing(null), () => undefined)).toBeNull();
      expect(
        transferInOf('fintava', timing(null), (k) => NUVION_SET[k]),
      ).toBeNull();
    });

    it('carries the arrival minutes with it when they are set, under either provider', () => {
      expect(transferInOf('fintava', timing(5), () => undefined)).toEqual({
        arrivalMinutes: 5,
      });
      expect(transferInOf('nuvion', timing(5), (k) => NUVION_SET[k])).toEqual({
        feeKobo: 0,
        arrivalMinutes: 5,
      });
    });

    it('the quote service holds what the settings say', () => {
      expect(service('nuvion', NUVION_SET).transferIn).toEqual({ feeKobo: 0 });
      expect(
        service('nuvion', { ...NUVION_SET, [A.bankIn]: '15' }).transferIn,
      ).toEqual({ feeKobo: 0, arrivalMinutes: 15 });
      expect(service('fintava').transferIn).toBeNull();
    });
  });

  describe('a bank quote (FeeQuoteView.arrivalMinutes)', () => {
    const NOW = new Date('2026-10-24T09:00:00.000Z');

    it('carries the usual time of a send to a bank when it is set, and only on a bank quote', () => {
      const s = service('nuvion', { ...NUVION_SET, [A.bankOut]: '10' });
      expect(
        s.quote(USER, { kind: 'bank_transfer', amountKobo: 1_000_000 }, NOW)
          .arrivalMinutes,
      ).toBe(10);
      for (const kind of ['wawu_transfer', 'purchase'] as const) {
        const q = s.quote(USER, { kind, amountKobo: 1_000_000 }, NOW);
        expect('arrivalMinutes' in q).toBe(false);
      }
    });

    it('is absent when the setting is not set, so a quote reads exactly as before', () => {
      const q = service('nuvion', NUVION_SET).quote(
        USER,
        { kind: 'bank_transfer', amountKobo: 1_000_000 },
        NOW,
      );
      expect('arrivalMinutes' in q).toBe(false);
    });

    it('a quote_changed refusal carries the same quote, arrival and all', () => {
      const s = service('nuvion', { ...NUVION_SET, [A.bankOut]: '10' });
      const input = { kind: 'bank_transfer', amountKobo: 1_000_000 } as const;
      expect(s.quote(USER, input, NOW).arrivalMinutes).toBe(
        s.check(
          USER,
          input,
          s.quote(USER, input, NOW).totalKobo,
          s.quote(USER, input, NOW).quoteToken,
          NOW,
        ).arrivalMinutes,
      );
    });
  });
});
