import { GeoService } from '../geo.service';
import { COUNTRY_NAME_OVERRIDES, englishName } from '../country-names';
import { CA, GB, GH, KE, NG, US, ZA, type IsoRows } from './iso-3166-2.fixture';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { country as isoCountries } from '@koshmoney/countries';
import regionData from '../data/regions.json';

/**
 * GEO-02 round 1 (lead ruling): the lists agree with ISO 3166 for the countries
 * pinned here, and the country names are the English ones people use.
 *
 * The expected lists are in iso-3166-2.fixture.ts, written out from the ISO
 * tables and not read from the data under test.
 */
describe('The country and region lists against ISO 3166 (GEO-02 round 1)', () => {
  const geo = new GeoService();
  const sorted = (rows: IsoRows) =>
    [...rows].sort((a, b) => a[0].localeCompare(b[0]));
  const served = (cc: string) =>
    (geo.regions(cc) ?? [])
      .map((r) => [r.code, r.name] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));

  describe.each([
    ['Nigeria', 'NG', NG, 37],
    ['the United States', 'US', US, 57],
    ['Great Britain', 'GB', GB, 221],
    ['Ghana', 'GH', GH, 16],
    ['Kenya', 'KE', KE, 47],
    ['South Africa', 'ZA', ZA, 9],
    ['Canada', 'CA', CA, 13],
  ] as const)('%s (%s)', (_name, cc, iso, count) => {
    it(`serves exactly ISO's ${count} regions, with ISO's codes and English names`, () => {
      expect(iso).toHaveLength(count);
      expect(served(cc)).toEqual(sorted(iso));
    });

    it('serves each once, with a code of its own country and a type', () => {
      const list = geo.regions(cc)!;
      expect(new Set(list.map((r) => r.code)).size).toBe(list.length);
      for (const r of list) {
        expect(r.code.startsWith(`${cc}-`)).toBe(true);
        expect(r.type.length).toBeGreaterThan(0);
      }
    });
  });

  it('Nigeria is 36 states and the Federal Capital Territory; the United States is 50 states and DC (and its six outlying areas)', () => {
    const ng = geo.regions('NG')!;
    expect(ng.filter((r) => r.type === 'State')).toHaveLength(36);
    expect(ng.find((r) => r.code === 'NG-FC')).toBeDefined();
    const us = geo.regions('US')!;
    expect(us.filter((r) => r.type === 'State')).toHaveLength(50);
    expect(us.find((r) => r.code === 'US-DC')?.name).toBe(
      'District of Columbia',
    );
  });

  it("South Africa's provinces carry today's codes and English names, not the retired ones", () => {
    const codes = geo.regions('ZA')!.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['ZA-GP', 'ZA-KZN']));
    expect(codes).not.toEqual(expect.arrayContaining(['ZA-GT']));
    expect(codes).not.toEqual(expect.arrayContaining(['ZA-NL']));
    const names = geo.regions('ZA')!.map((r) => r.name);
    for (const vernacular of [
      'Foreisetata',
      'iTlhagwini-Kapa',
      'GaZulu-Natala',
      'iMpumalanga',
      'Bokone Bophirima',
    ]) {
      expect(names).not.toContain(vernacular);
    }
  });

  it('Ghana has its 16 regions and no Brong-Ahafo', () => {
    const codes = geo.regions('GH')!.map((r) => r.code);
    expect(codes).toHaveLength(16);
    expect(codes).not.toContain('GH-BA');
    expect(codes).toEqual(
      expect.arrayContaining([
        'GH-AF',
        'GH-BO',
        'GH-BE',
        'GH-NE',
        'GH-OT',
        'GH-SV',
        'GH-WN',
      ]),
    );
  });

  it('Great Britain offers no grouping and no council that has been replaced', () => {
    const codes = geo.regions('GB')!.map((r) => r.code);
    for (const gone of [
      'GB-EAW',
      'GB-GBN',
      'GB-UKM',
      'GB-ANT',
      'GB-BMH',
      'GB-NTH',
    ]) {
      expect(codes).not.toContain(gone);
    }
    expect(codes).toEqual(
      expect.arrayContaining([
        'GB-ENG',
        'GB-SCT',
        'GB-WLS',
        'GB-NIR',
        'GB-BCP',
        'GB-WNH',
      ]),
    );
  });

  describe('the region data is iso-3166 4.4.0, built by the script', () => {
    const root = join(__dirname, '../../..');
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as {
      devDependencies: Record<string, string>;
    };
    const data = regionData as unknown as {
      source: string;
      excluded: Record<string, string>;
      renamed: Record<string, string>;
      regions: Record<
        string,
        Array<{ code: string; name: string; type: string }>
      >;
    };

    it('names its source, and iso-3166 is pinned to that exact version', () => {
      expect(data.source).toBe('iso-3166@4.4.0');
      expect(pkg.devDependencies['iso-3166']).toBe('4.4.0');
    });

    it('is exactly what scripts/geo/build-regions.mjs builds from it today (so a bump of either is a rebuild)', () => {
      const run = spawnSync(
        process.execPath,
        ['scripts/geo/build-regions.mjs', '--check'],
        { cwd: root, encoding: 'utf8' },
      );
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
    });

    it("every country's served codes and names are the JSON's, and no country is served that is not in ISO 3166-1", () => {
      const isoCodes = new Set(isoCountries.all().map((c) => c.alpha2));
      let total = 0;
      for (const c of geo.countries()) {
        const fromJson = (data.regions[c.code] ?? [])
          .map((r) => [r.code, r.name] as const)
          .sort((a, b) => a[0].localeCompare(b[0]));
        expect(served(c.code)).toEqual(fromJson);
        expect(c.hasRegions).toBe(fromJson.length > 0);
        total += fromJson.length;
      }
      for (const cc of Object.keys(data.regions))
        expect(isoCodes.has(cc)).toBe(true);
      expect(total).toBe(
        Object.values(data.regions).reduce((n, l) => n + l.length, 0),
      );
      expect(total).toBeGreaterThan(5000);
    });

    it('holds each code once across the world, under its own country, with a name and a type', () => {
      const seen = new Set<string>();
      for (const [cc, list] of Object.entries(data.regions)) {
        for (const r of list) {
          expect(r.code.startsWith(`${cc}-`)).toBe(true);
          expect(seen.has(r.code)).toBe(false);
          seen.add(r.code);
          expect(r.name.trim().length).toBeGreaterThan(0);
          expect(r.type.trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('differs from iso-3166 only where the script says so: four places left out, two names spelled as ISO does', () => {
      expect(Object.keys(data.excluded).sort()).toEqual([
        'GB-EAW',
        'GB-GBN',
        'GB-UKM',
        'GH-BA',
      ]);
      expect(data.renamed).toEqual({
        'ZA-KZN': 'KwaZulu-Natal',
        'ZA-NW': 'North West',
      });
      const served = new Set(
        Object.values(data.regions).flatMap((l) => l.map((r) => r.code)),
      );
      for (const code of Object.keys(data.excluded))
        expect(served.has(code)).toBe(false);
    });

    it('serves a type for the newer codes the type package has no entry for', () => {
      const type = (cc: string, code: string) =>
        geo.regions(cc)!.find((r) => r.code === code)?.type;
      expect(type('ZA', 'ZA-GP')).toBe('Province');
      expect(type('ZA', 'ZA-KZN')).toBe('Province');
      expect(type('GB', 'GB-BCP')).toBe('Unitary authority');
      expect(type('GB', 'GB-ABC')).toBe('District council area');
      expect(type('GH', 'GH-AF')).toBe('Region');
    });

    it('a region is stored by the ISO code for countries outside the seven pinned, too', () => {
      const code = (cc: string, name: string) =>
        geo.regions(cc)!.find((r) => r.name === name)?.code;
      expect(code('CN', 'Beijing Shi')).toBe('CN-BJ');
      expect(code('PL', 'Mazowieckie')).toBe('PL-14');
      const india = geo.regions('IN')!.map((r) => r.code);
      expect(india).toEqual(expect.arrayContaining(['IN-UK', 'IN-CG']));
      expect(india).not.toEqual(expect.arrayContaining(['IN-UT']));
      expect(india).not.toEqual(expect.arrayContaining(['IN-CT']));
    });
  });

  describe('country names', () => {
    it('are the English ones, not the ISO table style', () => {
      const name = (cc: string) => geo.country(cc)?.name;
      expect(name('MK')).toBe('North Macedonia');
      expect(name('CD')).toBe('Democratic Republic of the Congo');
      expect(name('CG')).toBe('Republic of the Congo');
      expect(name('KR')).toBe('South Korea');
      expect(name('KP')).toBe('North Korea');
      expect(name('GB')).toBe('United Kingdom');
      expect(name('US')).toBe('United States');
      expect(name('NG')).toBe('Nigeria');
      expect(name('CI')).toBe("Côte d'Ivoire");
      expect(name('SZ')).toBe('Eswatini');
      expect(name('TR')).toBe('Türkiye');
      expect(name('CZ')).toBe('Czechia');
    });

    it('have no ISO-table comma form, no leading "The", no abbreviation and no repeat', () => {
      const names = geo.countries().map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) {
        expect(n).not.toMatch(/^The /);
        expect(n).not.toMatch(/, The\b/i);
        expect(n).not.toMatch(/the Former/i);
        expect(n).not.toMatch(/Republic Of\b/);
        expect(n.length).toBeGreaterThan(3);
      }
      expect(names.filter((n) => /, /.test(n))).toEqual(
        expect.not.arrayContaining([
          'Congo, The Democratic Republic Of The',
          'Korea, Republic of',
        ]),
      );
    });

    it('still list the same 249 countries as the package', () => {
      expect(
        geo
          .countries()
          .map((c) => c.code)
          .sort(),
      ).toEqual(
        isoCountries
          .all()
          .map((c) => c.alpha2)
          .sort(),
      );
    });

    it('every name override changes something, and the package has a name for every other country', () => {
      for (const [cc, name] of Object.entries(COUNTRY_NAME_OVERRIDES)) {
        expect(geo.country(cc)?.name).toBe(name);
      }
      for (const c of geo.countries()) expect(englishName(c.code)).toBeTruthy();
    });

    it('are found by the older names too', () => {
      expect(geo.countryFromText('Macedonia')).toBe('MK');
      expect(geo.countryFromText('North Macedonia')).toBe('MK');
      expect(geo.countryFromText('Ivory Coast')).toBe('CI');
      expect(geo.countryFromText('Korea, Republic of')).toBe('KR');
      expect(geo.countryFromText('Democratic Republic of the Congo')).toBe(
        'CD',
      );
    });
  });
});
