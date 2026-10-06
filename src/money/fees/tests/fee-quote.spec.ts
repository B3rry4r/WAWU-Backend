import { inspect } from 'node:util';
import { ConfigService } from '@nestjs/config';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyError } from '../../money-error';
import type { FeeQuoteView } from '../../money-view.type';
import {
  bandsSetting,
  DEFAULT_MERCHANT_MAX_PER_TXN_KOBO,
  FEE_CONFIG_KEYS,
  FeeConfigError,
  FeeSettings,
  koboSetting,
  quoteSecondsSetting,
} from '../fee-config';
import { FeeQuoteService, type FeeQuoteInput } from '../fee-quote.service';

/**
 * The fee quote's arithmetic and its signed token (task WALLET-15), with no
 * database and no HTTP: the schedule in FeeSettings (ruled defaults from
 * the mobile repo's docs/fintava/fees.md and R-10, and what config may
 * change), the four kinds, the band edges the task names, the merchant cap,
 * and check() as the paying request will call it. The route over HTTP is
 * money-fees.contract.spec.ts.
 */

const KEY = 'k'.repeat(40);
const USER = '0f0a5a3e-6a35-4c35-9a1b-6a8f2f3f9a01';
const OTHER = '9b2c8d7e-1f3a-4b5c-8d9e-0a1b2c3d4e5f';

function settings(env: Record<string, string> = {}): FeeSettings {
  return new FeeSettings(
    new ConfigService({ [FEE_CONFIG_KEYS.quoteKey]: KEY, ...env }),
  );
}

function service(env: Record<string, string> = {}): FeeQuoteService {
  return new FeeQuoteService(settings(env));
}

const naira = (n: number) => Math.round(n * 100);

function reasonOf(fn: () => unknown): MoneyErrorReason & { status: number } {
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

/** Every money figure of a quote is an integer number of kobo. */
function expectKobo(q: FeeQuoteView) {
  const figures = [
    q.amountKobo,
    q.totalKobo,
    q.fee.providerFeeKobo,
    q.fee.wawuFeeKobo,
    q.fee.totalFeeKobo,
    ...q.parts.map((p) => p.amountKobo),
  ];
  for (const n of figures) expect(Number.isSafeInteger(n)).toBe(true);
  expect(q.parts.reduce((n, p) => n + p.amountKobo, 0)).toBe(
    q.fee.totalFeeKobo,
  );
  expect(q.fee.providerFeeKobo + q.fee.wawuFeeKobo).toBe(q.fee.totalFeeKobo);
  expect(q.amountKobo + q.fee.totalFeeKobo).toBe(q.totalKobo);
}

describe('fee quote (WALLET-15)', () => {
  const now = new Date('2026-10-03T12:00:00.000Z');

  describe('what each kind costs, from the ruled schedule', () => {
    const quotes = service();
    const q = (input: FeeQuoteInput) => {
      const v = quotes.quote(USER, input, now);
      expectKobo(v);
      return v;
    };

    it('a user sending ₦10,000 to a bank sees ₦40 + ₦25 = ₦65 and a total of ₦10,065', () => {
      const v = q({ kind: 'bank_transfer', amountKobo: naira(10_000) });
      expect(v.parts).toEqual([
        { code: 'bank_transfer', source: 'provider', amountKobo: naira(40) },
        { code: 'wawu_fee', source: 'wawu', amountKobo: naira(25) },
      ]);
      expect(v.fee).toEqual({
        providerFeeKobo: naira(40),
        wawuFeeKobo: naira(25),
        totalFeeKobo: naira(65),
      });
      expect(v.totalKobo).toBe(naira(10_065));
      expect(v.billCategory).toBeNull();
    });

    it('a withdrawal is a bank send: the same ₦65 whatever the amount', () => {
      for (const amount of [1, naira(1), naira(4_999), naira(2_000_000)]) {
        expect(
          q({ kind: 'bank_transfer', amountKobo: amount }).fee.totalFeeKobo,
        ).toBe(naira(65));
      }
    });

    it('a ₦4,999 purchase pays ₦23.25 and a ₦5,000 purchase ₦15.75, and no WAWU fee', () => {
      const below = q({ kind: 'purchase', amountKobo: naira(4_999) });
      expect(below.parts).toEqual([
        { code: 'balance_transfer', source: 'provider', amountKobo: 2325 },
      ]);
      expect(below.fee.wawuFeeKobo).toBe(0);
      expect(below.totalKobo).toBe(naira(4_999) + 2325);

      const at = q({ kind: 'purchase', amountKobo: naira(5_000) });
      expect(at.parts).toEqual([
        { code: 'balance_transfer', source: 'provider', amountKobo: 1575 },
      ]);
      expect(at.totalKobo).toBe(naira(5_000) + 1575);
    });

    it('the band edge is exactly ₦5,000: one kobo below it is the first band', () => {
      expect(
        q({ kind: 'purchase', amountKobo: 499_999 }).fee.totalFeeKobo,
      ).toBe(2325);
      expect(
        q({ kind: 'purchase', amountKobo: 500_000 }).fee.totalFeeKobo,
      ).toBe(1575);
      expect(q({ kind: 'purchase', amountKobo: 1 }).fee.totalFeeKobo).toBe(
        2325,
      );
      expect(
        q({ kind: 'purchase', amountKobo: naira(50_000) }).fee.totalFeeKobo,
      ).toBe(1575);
      expect(
        q({ kind: 'purchase', amountKobo: naira(900_000) }).fee.totalFeeKobo,
      ).toBe(1575);
    });

    it('a send to a WAWU user is the balance-transfer charge by band plus WAWU ₦10', () => {
      const small = q({ kind: 'wawu_transfer', amountKobo: naira(1_000) });
      expect(small.parts).toEqual([
        { code: 'balance_transfer', source: 'provider', amountKobo: 2325 },
        { code: 'wawu_fee', source: 'wawu', amountKobo: naira(10) },
      ]);
      expect(small.totalKobo).toBe(naira(1_000) + 2325 + 1000);
      const large = q({ kind: 'wawu_transfer', amountKobo: naira(25_000) });
      expect(large.fee).toEqual({
        providerFeeKobo: 1575,
        wawuFeeKobo: 1000,
        totalFeeKobo: 2575,
      });
    });

    it('an electricity bill of ₦10,000 quotes its ₦100 bill charge and the balance-transfer charge, each as its own part', () => {
      const v = q({
        kind: 'bill',
        billCategory: 'electricity',
        amountKobo: naira(10_000),
      });
      expect(v.billCategory).toBe('electricity');
      expect(v.parts).toEqual([
        { code: 'bill_charge', source: 'provider', amountKobo: naira(100) },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 0 },
        { code: 'balance_transfer', source: 'provider', amountKobo: 1575 },
      ]);
      expect(v.totalKobo).toBe(naira(10_000) + naira(100) + 1575);
    });

    it('cable is ₦100, airtime and data ₦0; each still pays the balance-transfer charge into WAWU', () => {
      const charge = (billCategory: FeeQuoteInput['billCategory']) =>
        q({ kind: 'bill', billCategory, amountKobo: naira(1_000) }).parts;
      expect(charge('cable')[0].amountKobo).toBe(naira(100));
      expect(charge('airtime')[0].amountKobo).toBe(0);
      expect(charge('data')[0].amountKobo).toBe(0);
      for (const c of ['cable', 'airtime', 'data'] as const) {
        expect(charge(c)[2]).toEqual({
          code: 'balance_transfer',
          source: 'provider',
          amountKobo: 2325,
        });
      }
    });

    it('a bill is banded on what moves into WAWU: the bill plus its charge', () => {
      // ₦4,950 + ₦100 = ₦5,050 moves, which is the second band.
      const v = q({
        kind: 'bill',
        billCategory: 'electricity',
        amountKobo: naira(4_950),
      });
      expect(v.parts[2].amountKobo).toBe(1575);
      // Airtime has no charge, so ₦4,950 of airtime is the first band.
      const a = q({
        kind: 'bill',
        billCategory: 'airtime',
        amountKobo: naira(4_950),
      });
      expect(a.parts[2].amountKobo).toBe(2325);
    });

    it('the daily limit is not known, so nothing is stopped and nothing is shown', () => {
      const v = q({ kind: 'wawu_transfer', amountKobo: naira(1_000) });
      expect(v.withinDailyLimit).toBe(true);
      expect(v.remainingTodayKobo).toBeNull();
    });

    it('a quote expires FEE_QUOTE_SECONDS after it is given (300 by default)', () => {
      const v = q({ kind: 'purchase', amountKobo: naira(500) });
      expect(v.expiresAt).toBe('2026-10-03T12:05:00.000Z');
      const longer = service({ [FEE_CONFIG_KEYS.quoteSeconds]: '600' });
      expect(
        longer.quote(USER, { kind: 'purchase', amountKobo: 100 }, now)
          .expiresAt,
      ).toBe('2026-10-03T12:10:00.000Z');
    });
  });

  describe('the merchant wallet cap (MERCHANT_MAX_PER_TXN_KOBO)', () => {
    it('a purchase or bill whose total passes the cap is 400 amount_out_of_range with the largest amount that fits', () => {
      const quotes = service();
      for (const input of [
        { kind: 'purchase' as const },
        { kind: 'bill' as const, billCategory: 'electricity' as const },
      ]) {
        const r = reasonOf(() =>
          quotes.quote(
            USER,
            { ...input, amountKobo: DEFAULT_MERCHANT_MAX_PER_TXN_KOBO },
            now,
          ),
        );
        expect(r.status).toBe(400);
        expect(r.code).toBe('amount_out_of_range');
        expect(r.message).not.toMatch(/—/);
        const max = r.maximumKobo!;
        const fits = quotes.quote(USER, { ...input, amountKobo: max }, now);
        expect(fits.totalKobo).toBeLessThanOrEqual(
          DEFAULT_MERCHANT_MAX_PER_TXN_KOBO,
        );
        expect(() =>
          quotes.quote(USER, { ...input, amountKobo: max + 1 }, now),
        ).toThrow(MoneyError);
      }
    });

    it("a customer's own send is not bound by the merchant cap", () => {
      const quotes = service();
      for (const kind of ['wawu_transfer', 'bank_transfer'] as const) {
        const v = quotes.quote(
          USER,
          { kind, amountKobo: DEFAULT_MERCHANT_MAX_PER_TXN_KOBO * 3 },
          now,
        );
        expect(v.totalKobo).toBeGreaterThan(DEFAULT_MERCHANT_MAX_PER_TXN_KOBO);
      }
    });

    it('the cap is read from config', () => {
      const quotes = service({ [FEE_CONFIG_KEYS.merchantMaxPerTxn]: '100000' });
      expect(
        quotes.quote(USER, { kind: 'purchase', amountKobo: 97_675 }, now)
          .totalKobo,
      ).toBe(100_000);
      const r = reasonOf(() =>
        quotes.quote(USER, { kind: 'purchase', amountKobo: 97_676 }, now),
      );
      expect(r.maximumKobo).toBe(97_675);
    });

    it('a total a JSON number cannot carry exactly is refused, never rounded', () => {
      const r = reasonOf(() =>
        service().quote(
          USER,
          { kind: 'bank_transfer', amountKobo: Number.MAX_SAFE_INTEGER },
          now,
        ),
      );
      expect(r.code).toBe('amount_out_of_range');
      expect(Number.isSafeInteger(r.maximumKobo)).toBe(true);
    });
  });

  describe('config', () => {
    it('every figure can be set, and the quote follows it', () => {
      const quotes = service({
        [FEE_CONFIG_KEYS.bankTransfer]: '5000',
        [FEE_CONFIG_KEYS.bankTransferWawuFee]: '3000',
        [FEE_CONFIG_KEYS.wawuTransferWawuFee]: '0',
        [FEE_CONFIG_KEYS.balanceTransferBands]: '0:1000, 100000:500',
        [FEE_CONFIG_KEYS.electricity]: '12000',
        [FEE_CONFIG_KEYS.billWawuFee]: '700',
      });
      expect(
        quotes.quote(USER, { kind: 'bank_transfer', amountKobo: 1 }, now).fee
          .totalFeeKobo,
      ).toBe(8000);
      expect(
        quotes.quote(USER, { kind: 'wawu_transfer', amountKobo: 99_999 }, now)
          .fee.totalFeeKobo,
      ).toBe(1000);
      expect(
        quotes.quote(USER, { kind: 'wawu_transfer', amountKobo: 100_000 }, now)
          .fee.totalFeeKobo,
      ).toBe(500);
      const bill = quotes.quote(
        USER,
        { kind: 'bill', billCategory: 'electricity', amountKobo: 90_000 },
        now,
      );
      // 90,000 + 12,000 + 700 moves into WAWU: the second band.
      expect(bill.parts.map((p) => p.amountKobo)).toEqual([12000, 700, 500]);
    });

    it('a fee that is not a whole number of kobo stops the app at boot', () => {
      for (const bad of ['23.25', '-1', 'abc', '1e3', '1000001']) {
        expect(() => settings({ [FEE_CONFIG_KEYS.bankTransfer]: bad })).toThrow(
          FeeConfigError,
        );
      }
      expect(koboSetting(' ', 'X', 7)).toBe(7);
      expect(koboSetting(undefined, 'X', 7)).toBe(7);
    });

    it('bands must start at 0 and rise', () => {
      expect(bandsSetting('0:2325,500000:1575')).toEqual([
        { fromKobo: 0, feeKobo: 2325 },
        { fromKobo: 500000, feeKobo: 1575 },
      ]);
      for (const bad of [
        '1:2325',
        '0:2325,0:1575',
        '0:2325,600000:1,500000:2',
        '0:',
        '0-2325',
        '0:2325,',
      ]) {
        expect(() => bandsSetting(bad)).toThrow(FeeConfigError);
      }
    });

    it('quote life is 60 to 3600 seconds; a short FEE_QUOTE_KEY stops the app', () => {
      expect(quoteSecondsSetting('')).toBe(300);
      expect(() => quoteSecondsSetting('59')).toThrow(FeeConfigError);
      expect(() => quoteSecondsSetting('3601')).toThrow(FeeConfigError);
      expect(
        () =>
          new FeeSettings(
            new ConfigService({ [FEE_CONFIG_KEYS.quoteKey]: 'short' }),
          ),
      ).toThrow(FeeConfigError);
    });

    it('the signing key is never readable off the settings object', () => {
      const s = settings();
      expect(JSON.stringify(s)).not.toContain(KEY);
      expect(inspect(s)).not.toContain(KEY);
    });
  });

  describe('check(): what the paying request calls', () => {
    const quotes = service();
    const input: FeeQuoteInput = {
      kind: 'bank_transfer',
      amountKobo: naira(10_000),
    };
    const given = quotes.quote(USER, input, now);
    const later = new Date(now.getTime() + 60_000);

    function changed(fn: () => unknown): FeeQuoteView {
      const r = reasonOf(fn);
      expect(r.status).toBe(409);
      expect(r.code).toBe('quote_changed');
      expect(r.feeQuote).toBeDefined();
      return r.feeQuote!;
    }

    it('honours its own quote, for the same person and amount, before it expires', () => {
      const v = quotes.check(
        USER,
        input,
        given.totalKobo,
        given.quoteToken,
        later,
      );
      expect(v.totalKobo).toBe(naira(10_065));
    });

    it('a quote past expiresAt is quote_changed, with a new quote to show', () => {
      const fresh = changed(() =>
        quotes.check(
          USER,
          input,
          given.totalKobo,
          given.quoteToken,
          new Date(now.getTime() + 300_000),
        ),
      );
      expect(fresh.totalKobo).toBe(given.totalKobo);
      expect(fresh.quoteToken).not.toBe(given.quoteToken);
    });

    it('another person, another amount, kind or category is not this quote', () => {
      changed(() =>
        quotes.check(OTHER, input, given.totalKobo, given.quoteToken, later),
      );
      changed(() =>
        quotes.check(
          USER,
          { ...input, amountKobo: input.amountKobo + 1 },
          given.totalKobo,
          given.quoteToken,
          later,
        ),
      );
      changed(() =>
        quotes.check(
          USER,
          { ...input, kind: 'wawu_transfer' },
          given.totalKobo,
          given.quoteToken,
          later,
        ),
      );
      const bill = quotes.quote(
        USER,
        { kind: 'bill', billCategory: 'electricity', amountKobo: 50_000 },
        now,
      );
      changed(() =>
        quotes.check(
          USER,
          { kind: 'bill', billCategory: 'cable', amountKobo: 50_000 },
          bill.totalKobo,
          bill.quoteToken,
          later,
        ),
      );
    });

    it('a total the person did not see is quote_changed', () => {
      changed(() =>
        quotes.check(USER, input, given.totalKobo - 1, given.quoteToken, later),
      );
    });

    it('an edited, foreign or malformed token is never honoured', () => {
      const [payload, sig] = given.quoteToken.split('.');
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      const edited = Buffer.from(JSON.stringify({ ...claims, t: 1 })).toString(
        'base64url',
      );
      changed(() =>
        quotes.check(USER, input, given.totalKobo, `${edited}.${sig}`, later),
      );
      const foreign = new FeeQuoteService(
        new FeeSettings(
          new ConfigService({ [FEE_CONFIG_KEYS.quoteKey]: 'z'.repeat(40) }),
        ),
      ).quote(USER, input, now);
      changed(() =>
        quotes.check(USER, input, given.totalKobo, foreign.quoteToken, later),
      );
      for (const junk of [
        '',
        '.',
        'a.b',
        `${payload}.${sig}.x`,
        'x'.repeat(5000),
      ]) {
        changed(() => quotes.check(USER, input, given.totalKobo, junk, later));
      }
    });

    it('a fee changed in config after the quote is quote_changed with the new total', () => {
      const raised = service({ [FEE_CONFIG_KEYS.bankTransfer]: '5000' });
      const fresh = changed(() =>
        raised.check(USER, input, given.totalKobo, given.quoteToken, later),
      );
      expect(fresh.totalKobo).toBe(naira(10_075));
    });
  });
});
