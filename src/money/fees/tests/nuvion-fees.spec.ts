import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { WalletProviderName } from '../../../wallet-provider/wallet-provider.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MONEY_ERROR_STATUS } from '../../money-contract';
import { MoneyError } from '../../money-error';
import type { FeeQuoteView } from '../../money-view.type';
import { FEE_CONFIG_KEYS, FeeConfigError, FeeSettings } from '../fee-config';
import { FeeQuoteService, type FeeQuoteInput } from '../fee-quote.service';
import { FEES_NOT_SET_MESSAGE } from '../fees-not-set';
import {
  feeOf,
  feeRuleSetting,
  NUVION_FEE_CONFIG_KEYS,
  readNuvionFees,
} from '../nuvion-fee-config';
import { unsetFeeSettings } from '../provider-fee-schedule';

/**
 * Fees as settings (task NUV-07, R-42), with no database and no HTTP. Nuvion
 * is stood in at the seam by its name alone: the quote reads the running
 * provider's `name` and never calls it (a quote asks no provider). The
 * figures below are the spec's own, not Nuvion's (Nuvion has published none).
 *
 * The HTTP side, with a Nuvion stand-in at WALLET_PROVIDER that records
 * every call, is nuvion-fees.contract.spec.ts.
 */

const KEY = 'n'.repeat(40);
const USER = '0f0a5a3e-6a35-4c35-9a1b-6a8f2f3f9a01';
const NOW = new Date('2026-10-08T09:00:00.000Z');
const K = NUVION_FEE_CONFIG_KEYS;

/** The spec's Nuvion charges: a flat book transfer, banded payout, flat inflow. */
const SET = {
  [K.bookTransfer]: '1234',
  [K.bankPayout]: '0:3100,500000:4200',
  [K.inflow]: '0',
};

function service(
  provider: WalletProviderName | null,
  env: Record<string, string> = {},
): FeeQuoteService {
  const config = new ConfigService({ [FEE_CONFIG_KEYS.quoteKey]: KEY, ...env });
  return new FeeQuoteService(
    new FeeSettings(config),
    provider === null ? undefined : { name: provider },
    config,
  );
}

function refusal(fn: () => unknown): MoneyErrorReason & { status: number } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MoneyError);
    const err = e as MoneyError;
    const res = err.getResponse() as { reason: MoneyErrorReason };
    return { ...res.reason, status: err.getStatus() };
  }
  throw new Error('expected a refusal');
}

const KINDS: FeeQuoteInput[] = [
  { kind: 'wawu_transfer', amountKobo: 1_000_000 },
  { kind: 'bank_transfer', amountKobo: 1_000_000 },
  { kind: 'purchase', amountKobo: 1_000_000 },
  { kind: 'bill', amountKobo: 1_000_000, billCategory: 'electricity' },
];

describe('NUV-07: Nuvion fee settings', () => {
  describe('reading a setting', () => {
    it('empty is unset (no default, ever); digits are one figure; from:fee pairs are bands', () => {
      for (const raw of [undefined, null, '', '   ']) {
        expect(feeRuleSetting(raw, K.bookTransfer)).toBeNull();
      }
      expect(feeRuleSetting('0', K.bookTransfer)).toEqual({
        kind: 'flat',
        feeKobo: 0,
      });
      expect(feeRuleSetting(' 2500 ', K.bookTransfer)).toEqual({
        kind: 'flat',
        feeKobo: 2500,
      });
      expect(feeRuleSetting('0:1000, 500000:2000', K.bankPayout)).toEqual({
        kind: 'bands',
        bands: [
          { fromKobo: 0, feeKobo: 1000 },
          { fromKobo: 500_000, feeKobo: 2000 },
        ],
      });
    });

    it('anything else stops the app at boot, naming the setting', () => {
      for (const raw of [
        'abc',
        '-1',
        '12.5',
        '1e3',
        '1,000',
        '1000001',
        '٣',
        '0:',
        ':100',
        '0:100,',
        '100:5',
        '0:100,0:200',
        '0:100,500:200,400:300',
        '0:-1',
        '0:100:200',
        '0:1000001',
      ]) {
        expect(() => feeRuleSetting(raw, K.inflow)).toThrow(FeeConfigError);
        expect(() => feeRuleSetting(raw, K.inflow)).toThrow(K.inflow);
      }
    });

    it('a banded charge is read on the amount, each band from its own edge', () => {
      const rule = feeRuleSetting('0:3100,500000:4200', K.bankPayout)!;
      expect(feeOf(rule, 1)).toBe(3100);
      expect(feeOf(rule, 499_999)).toBe(3100);
      expect(feeOf(rule, 500_000)).toBe(4200);
      expect(feeOf(rule, 9_000_000)).toBe(4200);
    });

    it('lists exactly the settings still unset, in order', () => {
      expect(readNuvionFees(() => undefined).unset).toEqual([
        K.bookTransfer,
        K.bankPayout,
        K.inflow,
      ]);
      expect(readNuvionFees((k) => SET[k as keyof typeof SET]).unset).toEqual(
        [],
      );
      for (const missing of Object.values(K)) {
        const env: Record<string, string> = { ...SET };
        delete env[missing];
        expect(readNuvionFees((k) => env[k]).unset).toEqual([missing]);
      }
      // Fintava's schedule always has its ruled figures.
      expect(unsetFeeSettings('fintava', () => undefined)).toEqual([]);
      expect(unsetFeeSettings('nuvion', () => undefined)).toHaveLength(3);
    });
  });

  describe('capability: with any Nuvion fee setting unset, every quote is fees_not_set', () => {
    it('with none set: every kind, and the paying check, answers 503 fees_not_set', () => {
      const quotes = service('nuvion');
      expect(quotes.feesSet).toBe(false);
      for (const input of KINDS) {
        const r = refusal(() => quotes.quote(USER, input, NOW));
        expect(r).toEqual({
          status: 503,
          code: 'fees_not_set',
          message: FEES_NOT_SET_MESSAGE,
        });
        expect(refusal(() => quotes.lines(input)).code).toBe('fees_not_set');
        // What a payment calls before it moves anything (MONEY-17, WALLET-07, WALLET-09).
        expect(
          refusal(() => quotes.check(USER, input, 1_100_000, 'any.token', NOW))
            .code,
        ).toBe('fees_not_set');
      }
      expect(MONEY_ERROR_STATUS.fees_not_set).toBe(503);
    });

    it('with any one of the three unset, the same', () => {
      for (const missing of Object.values(K)) {
        const env: Record<string, string> = { ...SET };
        delete env[missing];
        const quotes = service('nuvion', env);
        for (const input of KINDS) {
          expect(refusal(() => quotes.quote(USER, input, NOW)).code).toBe(
            'fees_not_set',
          );
        }
      }
    });

    it('a blank value is unset, not zero', () => {
      const quotes = service('nuvion', { ...SET, [K.inflow]: '   ' });
      expect(quotes.feesSet).toBe(false);
    });
  });

  describe("capability: with the settings filled in, the provider's charge and WAWU's fee make one Fees row", () => {
    const quotes = service('nuvion', SET);

    it("a send to a WAWU user: Nuvion's book transfer charge plus WAWU's ₦10 (R-10)", () => {
      const v = quotes.quote(
        USER,
        { kind: 'wawu_transfer', amountKobo: 2_000_000 },
        NOW,
      );
      expect(v.parts).toEqual([
        { code: 'balance_transfer', source: 'provider', amountKobo: 1234 },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 1000 },
      ]);
      // R-23: two parts, one Fees row: their sum, before Total.
      expect(v.fee).toEqual({
        providerFeeKobo: 1234,
        wawuFeeKobo: 1000,
        totalFeeKobo: 2234,
      });
      expect(v.totalKobo).toBe(2_002_234);
    });

    it("a send to a bank: Nuvion's payout charge by band plus WAWU's ₦25", () => {
      const below = quotes.quote(
        USER,
        { kind: 'bank_transfer', amountKobo: 499_999 },
        NOW,
      );
      expect(below.parts).toEqual([
        { code: 'bank_transfer', source: 'provider', amountKobo: 3100 },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 2500 },
      ]);
      expect(below.fee.totalFeeKobo).toBe(5600);
      expect(below.totalKobo).toBe(499_999 + 5600);
      const at = quotes.quote(
        USER,
        { kind: 'bank_transfer', amountKobo: 500_000 },
        NOW,
      );
      expect(at.fee).toEqual({
        providerFeeKobo: 4200,
        wawuFeeKobo: 2500,
        totalFeeKobo: 6700,
      });
    });

    it('a purchase: the book transfer charge only (no WAWU fee: the 85/15 split is its share)', () => {
      const v = quotes.quote(
        USER,
        { kind: 'purchase', amountKobo: 500_000 },
        NOW,
      );
      expect(v.parts).toEqual([
        { code: 'balance_transfer', source: 'provider', amountKobo: 1234 },
      ]);
      expect(v.fee).toEqual({
        providerFeeKobo: 1234,
        wawuFeeKobo: 0,
        totalFeeKobo: 1234,
      });
    });

    it('a bill is not payable through Nuvion, which has no bill payments (R-39)', () => {
      const r = refusal(() =>
        quotes.quote(
          USER,
          { kind: 'bill', amountKobo: 1_000_000, billCategory: 'airtime' },
          NOW,
        ),
      );
      expect(r).toEqual({
        status: 409,
        code: 'target_not_payable',
        message: 'Bills cannot be paid right now.',
      });
    });

    it("Fintava's merchant cap is Fintava's: a purchase under Nuvion is not refused by it", () => {
      const v = quotes.quote(
        USER,
        { kind: 'purchase', amountKobo: 2_000_000_000 },
        NOW,
      );
      expect(v.totalKobo).toBe(2_000_001_234);
      expect(
        refusal(() =>
          service('fintava', SET).quote(
            USER,
            { kind: 'purchase', amountKobo: 2_000_000_000 },
            NOW,
          ),
        ).code,
      ).toBe('amount_out_of_range');
    });

    it('the paying check honours exactly the total quoted under Nuvion', () => {
      const input: FeeQuoteInput = {
        kind: 'wawu_transfer',
        amountKobo: 70_000,
      };
      const v = quotes.quote(USER, input, NOW);
      expect(
        quotes.check(USER, input, v.totalKobo, v.quoteToken, NOW).totalKobo,
      ).toBe(71_234 + 1000);
    });

    it('the inflow charge is held for the add-money tasks', () => {
      expect(quotes.providerFees.inflowKobo(100_000)).toBe(0);
      expect(service(null).providerFees.inflowKobo(100_000)).toBeNull();
    });
  });

  describe('capability: changing a setting changes the quote, with no code change', () => {
    it('the same code, two settings, two quotes', () => {
      const input: FeeQuoteInput = {
        kind: 'wawu_transfer',
        amountKobo: 1_000_000,
      };
      const a = service('nuvion', SET).quote(USER, input, NOW);
      const b = service('nuvion', {
        ...SET,
        [K.bookTransfer]: '0:900,800000:1700',
      }).quote(USER, input, NOW);
      expect(a.parts[0].amountKobo).toBe(1234);
      expect(b.parts[0].amountKobo).toBe(1700);
      expect(b.totalKobo - a.totalKobo).toBe(1700 - 1234);
      const c = service('nuvion', { ...SET, [K.bankPayout]: '7' }).quote(
        USER,
        { kind: 'bank_transfer', amountKobo: 1_000_000 },
        NOW,
      );
      expect(c.parts[0]).toEqual({
        code: 'bank_transfer',
        source: 'provider',
        amountKobo: 7,
      });
    });

    it('a quote signed under one setting is not honoured once the setting changed (quote_changed with the new quote)', () => {
      const input: FeeQuoteInput = { kind: 'purchase', amountKobo: 300_000 };
      const before = service('nuvion', SET).quote(USER, input, NOW);
      const after = service('nuvion', { ...SET, [K.bookTransfer]: '2000' });
      const r = refusal(() =>
        after.check(USER, input, before.totalKobo, before.quoteToken, NOW),
      );
      expect(r.code).toBe('quote_changed');
      expect((r.feeQuote as FeeQuoteView).totalKobo).toBe(302_000);
    });
  });

  describe('a bad Nuvion setting stops a Nuvion server, never a Fintava one', () => {
    it('under nuvion, a set but unusable charge stops the service being built, naming it', () => {
      expect(() =>
        service('nuvion', { ...SET, [K.bankPayout]: '40.5' }),
      ).toThrow(FeeConfigError);
      expect(() =>
        service('nuvion', { ...SET, [K.bankPayout]: '40.5' }),
      ).toThrow(K.bankPayout);
    });

    it('under fintava the Nuvion settings are not read at all (a rollback never trips on them)', () => {
      const quotes = service('fintava', { [K.bankPayout]: 'nonsense' });
      expect(quotes.feesSet).toBe(true);
      expect(
        quotes.quote(
          USER,
          { kind: 'bank_transfer', amountKobo: 1_000_000 },
          NOW,
        ).fee,
      ).toEqual({
        providerFeeKobo: 4000,
        wawuFeeKobo: 2500,
        totalFeeKobo: 6500,
      });
    });
  });
});

/**
 * V3 / capability: under Fintava every quote is byte-identical to main.
 * `fintava-quote-golden.json` was generated from backend origin/main 965280e
 * (WALLET-15's FeeQuoteService, before NUV-07 changed anything): 224 inputs
 * (every kind and bill category at 16 amounts across the band edges, the
 * merchant cap and 2^53, under the ruled defaults and under a second,
 * fully set schedule with a low cap), each answer's JSON (the quote with
 * its signed token, or the refusal) hashed with SHA-256. Here the same
 * inputs go through today's FeeQuoteService, built three ways: with no
 * provider (as the WALLET-15 specs build it), with the Fintava adapter's
 * name, and with Nuvion settings present (ignored under Fintava).
 */
describe('NUV-07: under fintava every quote is byte-identical to main', () => {
  type Entry = {
    env: number;
    input: FeeQuoteInput;
    sha256: string;
  };
  const golden = JSON.parse(
    readFileSync(join(__dirname, 'fintava-quote-golden.json'), 'utf8'),
  ) as {
    now: string;
    quoteKey: string;
    user: string;
    envs: Record<string, string>[];
    entries: Entry[];
  };

  function answer(quotes: FeeQuoteService, input: FeeQuoteInput): string {
    let result: unknown;
    try {
      result = {
        quote: quotes.quote(golden.user, input, new Date(golden.now)),
      };
    } catch (e) {
      const err = e as MoneyError;
      result = { status: err.getStatus(), response: err.getResponse() };
    }
    return createHash('sha256')
      .update(JSON.stringify(result), 'utf8')
      .digest('hex');
  }

  it('has the inputs it was made with', () => {
    expect(golden.entries).toHaveLength(224);
    expect(golden.envs).toHaveLength(2);
  });

  for (const build of [
    'no provider',
    'fintava',
    'fintava with nuvion settings',
  ] as const) {
    it(`224 of 224 answers match, built with ${build}`, () => {
      const services = golden.envs.map((env) => {
        const all = {
          [FEE_CONFIG_KEYS.quoteKey]: golden.quoteKey,
          ...env,
          ...(build === 'fintava with nuvion settings' ? SET : {}),
        };
        const config = new ConfigService(all);
        return new FeeQuoteService(
          new FeeSettings(config),
          build === 'no provider' ? undefined : { name: 'fintava' },
          config,
        );
      });
      const differ = golden.entries
        .filter((e) => answer(services[e.env], e.input) !== e.sha256)
        .map((e) => `${e.env} ${JSON.stringify(e.input)}`);
      expect(differ).toEqual([]);
    });
  }
});
