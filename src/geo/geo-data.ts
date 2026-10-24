import { country as isoCountries } from '@koshmoney/countries';
import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  type CountryCode,
} from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';
import { englishName } from './country-names';
import regionData from './data/regions.json';
import type { GeoCountryView, GeoRegionView } from './geo.types';

/**
 * The country and region lists, built once from pinned data. Nothing here reaches
 * the network or imports a large package at run time.
 *
 *  - Countries: `@koshmoney/countries` 1.0.1 (MIT) for the ISO 3166-1 list and
 *    its alpha-3 codes; the English names from `i18n-iso-countries` 7.14.0 (MIT)
 *    with a reviewed override table (./country-names.ts); calling codes and
 *    example numbers from `libphonenumber-js` 1.13.15 (MIT; metadata from Google's
 *    libphonenumber, Apache 2.0).
 *  - Regions: ./data/regions.json, written by scripts/geo/build-regions.mjs from
 *    `iso-3166` 4.4.0 (MIT, a devDependency: it is ESM-only). That package is the
 *    source of truth for every ISO 3166-2 code and name, because region codes are
 *    stored on profiles. The script lists the few places it differs from it.
 *
 * All are pinned to an exact version in package.json. The lists change only when
 * someone bumps them and runs the script, so GEO-02's specs fail if the data and
 * the script, or the data and the hand-written ISO lists, part.
 */

/** ISO 3166-1 alpha-2 to a flag emoji (two regional indicator letters). */
export function flagOf(code: string): string {
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + code.charCodeAt(0) - 65,
    A + code.charCodeAt(1) - 65,
  );
}

const PHONE_COUNTRIES = new Set<string>(getCountries());

function dialCodeOf(code: string): string | null {
  return PHONE_COUNTRIES.has(code)
    ? `+${getCountryCallingCode(code as CountryCode)}`
    : null;
}

function exampleOf(code: string): { e164: string; national: string } | null {
  if (!PHONE_COUNTRIES.has(code)) return null;
  const sample = getExampleNumber(code as CountryCode, examples);
  return sample
    ? { e164: sample.number, national: sample.formatNational() }
    : null;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'en');

let cache: {
  countries: GeoCountryView[];
  byCode: Map<string, GeoCountryView>;
  /** ISO 3166-1 alpha-3 ("NGA") to alpha-2 ("NG"). */
  alpha3: Map<string, string>;
  regions: Map<string, GeoRegionView[]>;
} | null = null;

const REGIONS = regionData.regions as unknown as Record<
  string,
  GeoRegionView[]
>;

function build() {
  const regions = new Map<string, GeoRegionView[]>();
  for (const [code, list] of Object.entries(REGIONS)) {
    regions.set(
      code,
      list
        .map((r) => ({ code: r.code, name: r.name, type: r.type }))
        .sort(byName),
    );
  }

  const countries: GeoCountryView[] = isoCountries.all().map((c) => {
    const example = exampleOf(c.alpha2);
    return {
      code: c.alpha2,
      name: englishName(c.alpha2) ?? c.name,
      dialCode: dialCodeOf(c.alpha2),
      flag: flagOf(c.alpha2),
      exampleNumber: example?.e164 ?? null,
      exampleNational: example?.national ?? null,
      hasRegions: (regions.get(c.alpha2)?.length ?? 0) > 0,
    };
  });
  countries.sort(byName);
  const byCode = new Map(countries.map((c) => [c.code, c]));
  const alpha3 = new Map(isoCountries.all().map((c) => [c.alpha3, c.alpha2]));
  return { countries, byCode, alpha3, regions };
}

/** The lists, built on first use and kept. The arrays are shared: never mutate them. */
export function geoData() {
  cache ??= build();
  return cache;
}
