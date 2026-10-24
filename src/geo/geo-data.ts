import {
  country as isoCountries,
  subdivision as isoSubdivisions,
} from '@koshmoney/countries';
import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  type CountryCode,
} from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';
import type { GeoCountryView, GeoRegionView } from './geo.types';

/**
 * The country and region lists, built once from two pinned packages. Nothing
 * here reaches the network: both packages ship their data.
 *
 *  - `@koshmoney/countries` 1.0.1 (MIT): ISO 3166-1 countries and ISO 3166-2
 *    subdivisions with their names and types. Its data is the Wikipedia
 *    rendering of the ISO tables (its README, "Data Sources").
 *  - `libphonenumber-js` 1.13.15 (MIT; metadata from Google's libphonenumber,
 *    Apache 2.0): calling codes and example numbers.
 *
 * Both are pinned to an exact version in package.json. The lists change only
 * when someone bumps them, so GEO-02's spec fails if the counts move.
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
  regions: Map<string, GeoRegionView[]>;
} | null = null;

function build() {
  const regions = new Map<string, GeoRegionView[]>();
  for (const s of isoSubdivisions.all()) {
    const list = regions.get(s.countryCode) ?? [];
    list.push({ code: s.code.toUpperCase(), name: s.name, type: s.type });
    regions.set(s.countryCode, list);
  }
  for (const list of regions.values()) list.sort(byName);

  const countries: GeoCountryView[] = isoCountries.all().map((c) => {
    const example = exampleOf(c.alpha2);
    return {
      code: c.alpha2,
      name: c.name,
      dialCode: dialCodeOf(c.alpha2),
      flag: flagOf(c.alpha2),
      exampleNumber: example?.e164 ?? null,
      exampleNational: example?.national ?? null,
      hasRegions: (regions.get(c.alpha2)?.length ?? 0) > 0,
    };
  });
  countries.sort(byName);
  const byCode = new Map(countries.map((c) => [c.code, c]));
  return { countries, byCode, regions };
}

/** The lists, built on first use and kept. The arrays are shared: never mutate them. */
export function geoData() {
  cache ??= build();
  return cache;
}
