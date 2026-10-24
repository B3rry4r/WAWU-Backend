import { FX_FIAT_CODES, type FxFiatCode } from '../fx/fx-currencies';

/**
 * Which currency a person outside Nigeria is offered first (WALLET-41, R-87):
 * their country's own where Nuvion gives account details for it, otherwise
 * USD. The table is config, not code that a release has to change:
 * `WORLD_FIRST_CURRENCY_MAP` (for example `US:USD,GB:GBP,KE:USD`) adds to or
 * overrides the defaults below, and `WORLD_FIRST_CURRENCY_DEFAULT` replaces
 * the USD fallback. It only SUGGESTS: the person picks the first currency
 * themselves from every one an admin has left on.
 */

/** The euro area (Bulgaria from 1 January 2026). */
export const EURO_COUNTRIES: readonly string[] = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PT',
  'SK',
  'SI',
  'ES',
];

/** R-87: US USD, GB GBP, the euro countries EUR, CA CAD, AE AED, GH GHS. */
export const DEFAULT_FIRST_CURRENCY: Readonly<Record<string, FxFiatCode>> = {
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  AE: 'AED',
  GH: 'GHS',
  ...Object.fromEntries(EURO_COUNTRIES.map((c) => [c, 'EUR'])),
};

/** The country the person lives in, as an ISO 3166-1 alpha-2 code. */
export const COUNTRY_CODE = /^[A-Z]{2}$/;

export function isFiatCode(v: string): v is FxFiatCode {
  return (FX_FIAT_CODES as readonly string[]).includes(v);
}

/**
 * Reads `WORLD_FIRST_CURRENCY_MAP`. A bad entry stops the server at start,
 * as the fee settings do: a table that is silently half read would hand
 * people the wrong currency.
 */
export function parseFirstCurrencyMap(
  raw: string | undefined,
): Record<string, FxFiatCode> {
  const out: Record<string, FxFiatCode> = {};
  if (raw === undefined || raw.trim() === '') return out;
  for (const part of raw.split(',')) {
    const [country, currency, ...rest] = part.trim().split(':');
    if (
      rest.length > 0 ||
      !COUNTRY_CODE.test(country ?? '') ||
      !isFiatCode(currency ?? '')
    ) {
      throw new Error(
        'WORLD_FIRST_CURRENCY_MAP must look like US:USD,GB:GBP (a country code, a colon, one of USD, EUR, GBP, CAD, AED, GHS)',
      );
    }
    out[country] = currency as FxFiatCode;
  }
  return out;
}
