import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ConfigService } from '@nestjs/config';
import { toInternationalPhone } from '../../../wallet-provider/international-phone';
import type { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { OpenNairaWalletDto } from '../../opening/dto/open-wallet.dto';
import { worldIdentityKey } from '../../opening/reviewed-opening';
import {
  DEFAULT_FIRST_CURRENCY,
  EURO_COUNTRIES,
  listCountries,
  parseFirstCurrencyMap,
} from '../world-countries';
import { WorldSettings } from '../world-settings';

/**
 * WALLET-41 (R-87): the table of the currency each country is first
 * offered, the settings read from config, the open-wallet body for a person
 * outside Nigeria, and the identity claim a world opening takes. No database.
 */

function settings(env: Record<string, string> = {}, on = 1): WorldSettings {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const plan = {
    number: (k: string) => {
      if (k !== 'world.open.on') throw new Error('unknown setting');
      return on;
    },
  } as unknown as PlanSettingsService;
  return new WorldSettings(config, plan);
}

describe('the first currency by country (R-87)', () => {
  const s = settings();
  it.each([
    ['US', 'USD'],
    ['GB', 'GBP'],
    ['CA', 'CAD'],
    ['AE', 'AED'],
    ['GH', 'GHS'],
    ['DE', 'EUR'],
    ['FR', 'EUR'],
    ['ES', 'EUR'],
    ['IE', 'EUR'],
    // Anywhere else Nuvion has no account of its own for: USD.
    ['KE', 'USD'],
    ['IN', 'USD'],
    ['BR', 'USD'],
  ])('%s is offered %s first', (country, currency) => {
    expect(s.suggestedFor(country)).toBe(currency);
  });

  it('every euro country is EUR in the default table, and only they', () => {
    for (const c of EURO_COUNTRIES)
      expect(DEFAULT_FIRST_CURRENCY[c]).toBe('EUR');
    const eur = Object.entries(DEFAULT_FIRST_CURRENCY)
      .filter(([, v]) => v === 'EUR')
      .map(([k]) => k);
    expect(eur.sort()).toEqual([...EURO_COUNTRIES].sort());
  });

  it('the table is config: WORLD_FIRST_CURRENCY_MAP adds to and overrides it, the fallback is config too', () => {
    const t = settings({
      WORLD_FIRST_CURRENCY_MAP: 'KE:GHS, US:EUR',
      WORLD_FIRST_CURRENCY_DEFAULT: 'GBP',
    });
    expect(t.suggestedFor('KE')).toBe('GHS');
    expect(t.suggestedFor('US')).toBe('EUR');
    expect(t.suggestedFor('GB')).toBe('GBP');
    expect(t.suggestedFor('IN')).toBe('GBP');
  });

  it('a table that cannot be read stops the server at start', () => {
    expect(() => parseFirstCurrencyMap('US=USD')).toThrow();
    expect(() => parseFirstCurrencyMap('USA:USD')).toThrow();
    expect(() => parseFirstCurrencyMap('US:BTC')).toThrow();
    expect(() => settings({ WORLD_FIRST_CURRENCY_DEFAULT: 'XYZ' })).toThrow();
  });
});

describe('the fee, the limit and the switch come from config (R-10)', () => {
  it('WAWU opens for nothing until the owner names a fee', () => {
    const s = settings();
    expect(s.openFeeMinor('USD')).toBe(0n);
    expect(s.dailyLimit()).toBeNull();
    expect(s.isBlocked('US')).toBe(false);
    expect(s.openOn()).toBe(true);
  });

  it('reads a fee per currency, a daily cap and the countries held back', () => {
    const s = settings({
      WORLD_OPEN_FEE_GBP_MINOR: '150',
      WORLD_OPEN_DAILY_LIMIT: '40',
      WORLD_BLOCKED_COUNTRIES: 'ir, kp',
    });
    expect(s.openFeeMinor('GBP')).toBe(150n);
    expect(s.openFeeMinor('USD')).toBe(0n);
    expect(s.dailyLimit()).toBe(40);
    expect(s.isBlocked('IR')).toBe(true);
    expect(s.isBlocked('KP')).toBe(true);
    expect(s.isBlocked('US')).toBe(false);
  });

  it('a limit of 0 is no limit, and a bad figure stops the server', () => {
    expect(settings({ WORLD_OPEN_DAILY_LIMIT: '0' }).dailyLimit()).toBeNull();
    expect(() => settings({ WORLD_OPEN_DAILY_LIMIT: 'many' })).toThrow();
    expect(() => settings({ WORLD_OPEN_FEE_USD_MINOR: '1.5' })).toThrow();
    expect(() => settings({ WORLD_BLOCKED_COUNTRIES: 'Nigeria' })).toThrow();
  });

  it('the admin switch is read live, and one that cannot be read counts as off', () => {
    expect(settings({}, 0).openOn()).toBe(false);
    const config = { get: () => undefined } as unknown as ConfigService;
    const broken = {
      number: () => {
        throw new Error('no such setting');
      },
    } as unknown as PlanSettingsService;
    expect(new WorldSettings(config, broken).openOn()).toBe(false);
  });
});

describe('the number a person outside Nigeria signs up with', () => {
  it.each([
    ['+1 (212) 555-0198', '+12125550198'],
    ['+44 20 7123 4567', '+442071234567'],
    ['+233 20 123 4567', '+233201234567'],
    ['+2348012345678', '+2348012345678'],
  ])('%s is read as %s', (typed, e164) => {
    expect(toInternationalPhone(typed)).toBe(e164);
  });
  it.each(['08012345678', '2125550198', '+0123456789', '+1', '', null])(
    '%p is not a number with a country code',
    (typed) => {
      expect(toInternationalPhone(typed as string | null)).toBeNull();
    },
  );
});

describe('POST /money/wallet/open: the body for a person outside Nigeria', () => {
  const base = {
    firstName: 'Alex',
    lastName: 'Johnson',
    dateOfBirth: '1990-04-12',
    address: '210 West 77th Street',
    gender: 'male',
    city: 'New York',
    state: 'New York',
    postalCode: '10024',
    idType: 'international_passport',
    idNumber: 'P123456789',
    proofOfAddressType: 'utility_bill',
  };
  const check = async (body: Record<string, unknown>) =>
    validate(plainToInstance(OpenNairaWalletDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('needs no BVN and no NIN', async () => {
    expect(await check({ ...base, countryCode: 'US' })).toEqual([]);
    expect(
      await check({ ...base, countryCode: 'gb', firstCurrency: 'GBP' }),
    ).toEqual([]);
  });

  it('a Nigerian body, with NG or with no country, still needs both numbers', async () => {
    const fields = async (body: Record<string, unknown>) =>
      (await check(body)).map((e) => e.property).sort();
    expect(await fields(base)).toEqual(['bvn', 'nin']);
    expect(await fields({ ...base, countryCode: 'NG' })).toEqual([
      'bvn',
      'nin',
    ]);
    expect(
      await fields({ ...base, bvn: '22222222222', nin: '33333333333' }),
    ).toEqual([]);
  });

  it('the country is a 2-letter code and the first currency one we hold', async () => {
    const bad = async (extra: Record<string, unknown>) =>
      (await check({ ...base, ...extra })).map((e) => e.property);
    expect(await bad({ countryCode: 'USA' })).toEqual(['countryCode']);
    expect(await bad({ countryCode: 'US', firstCurrency: 'BTC' })).toEqual([
      'firstCurrency',
    ]);
    expect(await bad({ countryCode: 'US', nationality: 'Nigeria' })).toEqual([
      'nationality',
    ]);
  });
});

describe('the claim a world opening takes in place of a BVN', () => {
  const input = (idType: string, idNumber: string) =>
    ({ idType, idNumber }) as OpenNairaWalletDto;
  const details = (c: string) => ({ idDocument: { issuingCountry: c } });

  it('one document is one claim, however it is typed', () => {
    expect(
      worldIdentityKey(
        input('international_passport', 'p-123 456 789'),
        details('US'),
      ),
    ).toBe(
      worldIdentityKey(
        input('international_passport', 'P123456789'),
        details('US'),
      ),
    );
  });
  it('another country, another kind of document or another number is another claim', () => {
    const a = worldIdentityKey(
      input('international_passport', 'P123456789'),
      details('US'),
    );
    expect(
      worldIdentityKey(
        input('international_passport', 'P123456789'),
        details('GB'),
      ),
    ).not.toBe(a);
    expect(
      worldIdentityKey(input('drivers_license', 'P123456789'), details('US')),
    ).not.toBe(a);
    expect(
      worldIdentityKey(
        input('international_passport', 'P123456780'),
        details('US'),
      ),
    ).not.toBe(a);
  });
  it('can never equal a BVN, which is 11 digits', () => {
    const key = worldIdentityKey(
      input('national_id', '12345678901'),
      details('GH'),
    );
    expect(key).not.toMatch(/^\d{11}$/);
    expect(key.startsWith('world:')).toBe(true);
  });
});

describe('the countries to pick from', () => {
  const all = listCountries();
  it('names every country from the region data, with Nigeria, and no union or pseudo-region', () => {
    expect(all.length).toBeGreaterThan(200);
    const codes = new Set(all.map((c) => c.code));
    for (const code of [
      'NG',
      'US',
      'GB',
      'DE',
      'GH',
      'AE',
      'CA',
      'KE',
      'IN',
      'BR',
    ]) {
      expect(codes.has(code)).toBe(true);
    }
    for (const code of ['EU', 'UN', 'ZZ', 'XA', 'EZ'])
      expect(codes.has(code)).toBe(false);
    expect(all.find((c) => c.code === 'NG')?.name).toBe('Nigeria');
  });
  it('is sorted by name and every row has a name that is not its code', () => {
    const names = all.map((c) => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names);
    for (const c of all) expect(c.name).not.toBe(c.code);
  });
});
