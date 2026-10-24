import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeoService } from '../geo.service';
import { normalisePhone } from '../../waitlist/waitlist-contact';
import {
  isValidInternationalPhone,
  parseInternationalPhone,
  phoneCountryCode,
} from '../phone';

/**
 * GEO-02 (R-85): the country and region lists, the location rules and the
 * phone rule, with no database and no server. The lists are data from two
 * pinned packages, so the counts below fail when someone bumps either.
 */
describe('Country and region lists (GEO-02)', () => {
  const geo = new GeoService();

  describe('the two packages are pinned', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    it('names an exact version for each, never a range', () => {
      expect(pkg.dependencies['@koshmoney/countries']).toBe('1.0.1');
      expect(pkg.dependencies['libphonenumber-js']).toBe('1.13.15');
    });
  });

  describe('countries', () => {
    it('has every ISO 3166-1 country (249), A to Z', () => {
      const list = geo.countries();
      expect(list).toHaveLength(249);
      const names = list.map((c) => c.name);
      expect(names).toEqual(
        [...names].sort((a, b) => a.localeCompare(b, 'en')),
      );
      expect(new Set(list.map((c) => c.code)).size).toBe(249);
    });

    it('gives Nigeria its code, flag, dial code and a Nigerian example', () => {
      expect(geo.country('ng')).toMatchObject({
        code: 'NG',
        name: 'Nigeria',
        dialCode: '+234',
        flag: '🇳🇬',
        hasRegions: true,
      });
      expect(geo.country('NG')?.exampleNumber).toMatch(/^\+234[789]\d{9}$/);
      expect(geo.country('NG')?.exampleNational).toMatch(/^0[789]/);
    });

    it('gives every country with a dial code an example number that is valid', () => {
      const withCode = geo.countries().filter((c) => c.dialCode !== null);
      expect(withCode.length).toBeGreaterThan(230);
      for (const c of withCode) {
        expect(c.exampleNumber).not.toBeNull();
        const parsed = parseInternationalPhone(c.exampleNumber);
        expect(parsed?.e164).toBe(c.exampleNumber);
        expect(c.exampleNumber!.startsWith(c.dialCode!)).toBe(true);
      }
    });

    it('leaves the dial code and example empty for an ISO entry with no telephone numbers', () => {
      expect(geo.country('AQ')).toMatchObject({
        dialCode: null,
        exampleNumber: null,
        exampleNational: null,
      });
    });

    it('shares +1 and +44 across countries without mixing them up', () => {
      expect(geo.country('US')?.dialCode).toBe('+1');
      expect(geo.country('CA')?.dialCode).toBe('+1');
      expect(geo.country('GB')?.dialCode).toBe('+44');
    });

    it('does not know a code that is not on the list', () => {
      expect(geo.country('XX')).toBeNull();
      expect(geo.country('')).toBeNull();
      expect(geo.country(undefined)).toBeNull();
      expect(geo.regions('XX')).toBeNull();
    });
  });

  describe('regions', () => {
    it("lists Nigeria's 36 states and the Federal Capital Territory, with ISO codes and a type", () => {
      const list = geo.regions('NG')!;
      expect(list).toHaveLength(37);
      expect(list.find((r) => r.code === 'NG-LA')).toEqual({
        code: 'NG-LA',
        name: 'Lagos',
        type: 'State',
      });
      expect(list.find((r) => r.code === 'NG-FC')?.name).toMatch(/Abuja/);
    });

    it('holds only codes of their own country, each once, A to Z', () => {
      for (const c of geo.countries()) {
        const list = geo.regions(c.code)!;
        expect(c.hasRegions).toBe(list.length > 0);
        const codes = list.map((r) => r.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const r of list) {
          expect(r.code.startsWith(`${c.code}-`)).toBe(true);
          expect(r.name.length).toBeGreaterThan(0);
          expect(r.type.length).toBeGreaterThan(0);
        }
        const names = list.map((r) => r.name);
        expect(names).toEqual(
          [...names].sort((a, b) => a.localeCompare(b, 'en')),
        );
      }
    });

    it('has the United States and the United Kingdom', () => {
      expect(geo.regions('US')!.find((r) => r.code === 'US-CA')?.name).toBe(
        'California',
      );
      expect(geo.regions('GB')!.length).toBeGreaterThan(100);
    });
  });

  describe('a country from the text WAWU ID has always held', () => {
    it.each([
      ['Nigeria', 'NG'],
      ['nigeria', 'NG'],
      ['NG', 'NG'],
      ['ng', 'NG'],
      ['NGA', 'NG'],
      ['  Ghana ', 'GH'],
      ['United Kingdom', 'GB'],
      ['UK', 'GB'],
      ['USA', 'US'],
      ['United States of America', 'US'],
      ['Ivory Coast', 'CI'],
      ["Cote d'Ivoire", 'CI'],
      ['South Korea', 'KR'],
    ])('%s is %s', (text, code) => {
      expect(geo.countryFromText(text)).toBe(code);
    });

    it.each(['', '   ', 'Narnia', 'XX', '12', 7, null, undefined])(
      '%p is no country',
      (text) => {
        expect(geo.countryFromText(text)).toBeNull();
      },
    );
  });

  describe('a write to the structured location', () => {
    const none = {
      countryCode: null,
      regionCode: null,
      regionName: null,
      city: null,
    };
    const lagos = {
      countryCode: 'NG',
      regionCode: 'NG-LA',
      regionName: 'Lagos',
      city: 'Ikeja',
    };
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (
          e as { getResponse: () => { reason: { code: string } } }
        ).getResponse().reason.code;
      }
      return null;
    };

    it('takes a country in any case, and a region by code, tail or name', () => {
      expect(geo.checkLocation({ countryCode: 'ng' }, none)).toEqual({
        countryCode: 'NG',
      });
      for (const region of [
        { regionCode: 'NG-LA' },
        { regionCode: 'la' },
        { regionName: 'lagos' },
        { regionCode: 'NG-LA', regionName: 'Lagos' },
      ]) {
        expect(
          geo.checkLocation({ countryCode: 'NG', ...region }, none),
        ).toMatchObject({ regionCode: 'NG-LA', regionName: 'Lagos' });
      }
    });

    it('takes a region under the country already saved', () => {
      expect(
        geo.checkLocation(
          { regionCode: 'NG-OG' },
          { ...none, countryCode: 'NG' },
        ),
      ).toEqual({ regionCode: 'NG-OG', regionName: 'Ogun' });
    });

    it('refuses a country, region or name that is not on the lists', () => {
      expect(
        refusal(() => geo.checkLocation({ countryCode: 'ZZ' }, none)),
      ).toBe('country_invalid');
      expect(
        refusal(() =>
          geo.checkLocation({ countryCode: 'NG', regionCode: 'NG-ZZ' }, none),
        ),
      ).toBe('region_invalid');
      expect(
        refusal(() =>
          geo.checkLocation({ countryCode: 'NG', regionCode: 'US-CA' }, none),
        ),
      ).toBe('region_invalid');
      expect(
        refusal(() =>
          geo.checkLocation({ countryCode: 'NG', regionName: 'Narnia' }, none),
        ),
      ).toBe('region_invalid');
      expect(
        refusal(() =>
          geo.checkLocation(
            { countryCode: 'NG', regionCode: 'NG-LA', regionName: 'Ogun' },
            none,
          ),
        ),
      ).toBe('region_invalid');
    });

    it('refuses a region with no country, and a city that is too long', () => {
      expect(
        refusal(() => geo.checkLocation({ regionCode: 'NG-LA' }, none)),
      ).toBe('region_needs_country');
      expect(
        refusal(() => geo.checkLocation({ city: 'x'.repeat(81) }, none)),
      ).toBe('city_too_long');
      expect(
        geo.checkLocation({ city: 'x'.repeat(80) }, none).city,
      ).toHaveLength(80);
    });

    it('clears the region when the country changes or goes, unless the region is sent again', () => {
      expect(geo.checkLocation({ countryCode: 'GH' }, lagos)).toEqual({
        countryCode: 'GH',
        regionCode: null,
        regionName: null,
      });
      expect(geo.checkLocation({ countryCode: null }, lagos)).toEqual({
        countryCode: null,
        regionCode: null,
        regionName: null,
      });
      expect(
        geo.checkLocation({ countryCode: 'NG', city: 'Yaba' }, lagos),
      ).toEqual({ countryCode: 'NG', city: 'Yaba' });
      expect(
        geo.checkLocation({ countryCode: 'GH', regionCode: 'GH-AA' }, lagos),
      ).toMatchObject({ countryCode: 'GH', regionCode: 'GH-AA' });
    });

    it('leaves a key that was not sent, and clears one sent as null or empty', () => {
      expect(geo.checkLocation({}, lagos)).toEqual({});
      expect(geo.checkLocation({ city: '' }, lagos)).toEqual({ city: null });
      expect(geo.checkLocation({ city: '  Ikeja   North ' }, lagos)).toEqual({
        city: 'Ikeja North',
      });
      expect(
        geo.checkLocation({ regionCode: null, regionName: null }, lagos),
      ).toEqual({ regionCode: null, regionName: null });
    });

    it('takes a region as text for a country that ISO divides into nothing', () => {
      expect(geo.regions('AQ')).toEqual([]);
      expect(
        geo.checkLocation(
          { countryCode: 'AQ', regionName: 'Ross Dependency' },
          none,
        ),
      ).toEqual({
        countryCode: 'AQ',
        regionCode: null,
        regionName: 'Ross Dependency',
      });
      expect(
        refusal(() =>
          geo.checkLocation({ countryCode: 'AQ', regionCode: 'AQ-XX' }, none),
        ),
      ).toBe('region_invalid');
    });
  });

  describe('an admin filter', () => {
    it('upper-cases, and lets a region carry its country', () => {
      expect(geo.checkFilter('ng', undefined)).toEqual({ countryCode: 'NG' });
      expect(geo.checkFilter('NG', 'la')).toEqual({
        countryCode: 'NG',
        regionCode: 'NG-LA',
      });
      expect(geo.checkFilter(undefined, 'ng-la')).toEqual({
        countryCode: 'NG',
        regionCode: 'NG-LA',
      });
    });

    it('refuses an unknown country or a region of another country', () => {
      expect(() => geo.checkFilter('ZZ', undefined)).toThrow();
      expect(() => geo.checkFilter('GH', 'NG-LA')).toThrow();
      expect(() => geo.checkFilter(undefined, 'ZZ-AA')).toThrow();
    });
  });
});

describe('Phone numbers from any country (GEO-02, CONVENTIONS section 2)', () => {
  it.each([
    ['+2348031234567', undefined, '+2348031234567', 'NG'],
    ['+234 803 123 4567', undefined, '+2348031234567', 'NG'],
    ['002348031234567', undefined, '+2348031234567', 'NG'],
    ['0803 123 4567', 'NG', '+2348031234567', 'NG'],
    ['8031234567', 'NG', '+2348031234567', 'NG'],
    ['+44 (0)7911 123456', undefined, '+447911123456', null],
    ['+233 24 123 4567', undefined, '+233241234567', 'GH'],
    ['024 123 4567', 'GH', '+233241234567', 'GH'],
    ['+1 876 555 0123', undefined, '+18765550123', 'JM'],
    ['+27 82 123 4567', undefined, '+27821234567', 'ZA'],
  ])('reads %s (under %s) as %s', (raw, under, e164, country) => {
    const parsed = parseInternationalPhone(raw, under);
    expect(parsed?.e164).toBe(e164);
    if (country) expect(parsed?.countryCode).toBe(country);
  });

  it.each([
    ['0803 123 4567', undefined],
    ['0803 123 4567', 'GH'],
    ['+234 803 123', undefined],
    ['+999 1234567', undefined],
    ['not a number', 'NG'],
    ['', 'NG'],
    ['+44' + '1'.repeat(40), undefined],
    [12345, 'NG'],
    [null, 'NG'],
  ])('refuses %p (under %p)', (raw, under) => {
    expect(parseInternationalPhone(raw, under)).toBeNull();
    expect(isValidInternationalPhone(raw, under)).toBe(false);
  });

  it('drops control characters a paste can carry', () => {
    expect(parseInternationalPhone('‎+234 803 123 4567\n')?.e164).toBe(
      '+2348031234567',
    );
  });

  it('names the country a number is from, even when it is not a working number', () => {
    expect(phoneCountryCode('+2348031234567')).toBe('NG');
    expect(phoneCountryCode('+2348000000001')).toBe('NG');
    expect(phoneCountryCode('+233241234567')).toBe('GH');
    expect(phoneCountryCode('+18765550123')).toBe('JM');
    expect(phoneCountryCode('08031234567')).toBeNull();
    expect(phoneCountryCode(undefined)).toBeNull();
    expect(phoneCountryCode('')).toBeNull();
  });
});

describe('The launch registration keeps its Nigerian forms and takes any valid number (GEO-02)', () => {
  it('keeps every Nigerian form as it was', () => {
    for (const raw of [
      '08031234567',
      '8031234567',
      '2348031234567',
      '+234 803 123 4567',
      '(0803) 123-4567',
    ]) {
      expect(normalisePhone(raw)).toBe('+2348031234567');
    }
  });

  it('writes a valid number from elsewhere in E.164, dropping a bracketed trunk 0', () => {
    expect(normalisePhone('+44 (0)7911 123456')).toBe('+447911123456');
    expect(normalisePhone('00233 24 123 4567')).toBe('+233241234567');
    expect(normalisePhone('+1 (876) 555-0123')).toBe('+18765550123');
  });

  it('still takes what the plain length rule took, so nothing taken before is refused', () => {
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
  });

  it('refuses a +234 number that is not a Nigerian mobile, and what is no number', () => {
    for (const bad of [
      '+234 1 234 5678',
      '+234803123456',
      '02031234567',
      '0803 123 4567 x',
      '',
      '+0',
      'abc',
    ]) {
      expect(normalisePhone(bad)).toBeNull();
    }
  });
});

describe('A region named by text when two regions share the name (GEO-02 round 2)', () => {
  const geo = new GeoService();
  const none = {
    countryCode: null,
    regionCode: null,
    regionName: null,
    city: null,
  };

  it('is refused, and the code picks one: Dhaka is a division and a district in Bangladesh', () => {
    expect(() =>
      geo.checkLocation({ countryCode: 'BD', regionName: 'Dhaka' }, none),
    ).toThrow(/More than one region/);
    expect(
      geo.checkLocation({ countryCode: 'BD', regionCode: 'BD-C' }, none),
    ).toMatchObject({ regionCode: 'BD-C', regionName: 'Dhaka' });
    expect(
      geo.checkLocation({ countryCode: 'BD', regionCode: 'BD-13' }, none),
    ).toMatchObject({ regionCode: 'BD-13', regionName: 'Dhaka' });
  });
});
