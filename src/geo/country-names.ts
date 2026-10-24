import isoNames from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';

isoNames.registerLocale(en);

/**
 * English country names (GEO-02 round 1, lead ruling): `i18n-iso-countries`
 * 7.14.0 (MIT, pinned), its common name for each country ("North Macedonia",
 * "Côte d'Ivoire"), not the ISO table's ("Macedonia, the Former Yugoslav
 * Republic Of"). Where that package's common name is an abbreviation, clashes
 * with another country's or is still ISO-table style, this reviewed table
 * writes the name people use. `tests/geo-iso-lists.spec.ts` fails for a
 * duplicate name or for an entry here that no longer changes anything.
 */
export const COUNTRY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  AE: 'United Arab Emirates',
  AX: 'Åland Islands',
  BN: 'Brunei',
  CD: 'Democratic Republic of the Congo',
  CG: 'Republic of the Congo',
  FK: 'Falkland Islands',
  FM: 'Micronesia',
  GB: 'United Kingdom',
  GM: 'Gambia',
  KR: 'South Korea',
  LA: 'Laos',
  MD: 'Moldova',
  NL: 'Netherlands',
  RE: 'Réunion',
  ST: 'São Tomé and Príncipe',
  SY: 'Syria',
  TR: 'Türkiye',
  VA: 'Vatican City',
  VG: 'British Virgin Islands',
  VI: 'U.S. Virgin Islands',
};

/** The English name of an ISO 3166-1 alpha-2 code, or null when the package has none. */
export function englishName(code: string): string | null {
  const override = COUNTRY_NAME_OVERRIDES[code];
  if (override) return override;
  return isoNames.getName(code, 'en', { select: 'alias' }) ?? null;
}

/** Every English name the package knows for a code ("Ivory Coast", "USA"), for reading text a person typed. */
export function englishNames(code: string): string[] {
  const all = isoNames.getNames('en', { select: 'all' })[code] as unknown;
  if (Array.isArray(all))
    return all.filter((n): n is string => typeof n === 'string');
  return typeof all === 'string' ? [all] : [];
}
