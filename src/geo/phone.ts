import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';

/**
 * Phone numbers for every country (GEO-02, R-85; docs/contract/CONVENTIONS.md
 * section 2). Built on libphonenumber-js, pinned in package.json.
 *
 * This is the rule for a Hub route that only STORES or SHOWS a phone: any
 * number libphonenumber says is valid, kept as E.164 (`+447911123456`). A
 * route that pays a Nigerian rail (the wallet's identity check, opening, a
 * recipient search, airtime and data, the health plan) keeps its Nigerian
 * rule in `src/wallet-provider/nigerian-phone.ts`; nothing here replaces it.
 */

export interface ParsedPhone {
  /** `+2348031234567`. */
  e164: string;
  /** The calling code without the plus: `234`. */
  callingCode: string;
  /** The number without its calling code: `8031234567`. */
  nationalNumber: string;
  /** ISO 3166-1 alpha-2, or null when the code is shared and the number does not say which. */
  countryCode: string | null;
}

/** Control characters and the bidi marks a paste can carry are dropped before parsing. */
// eslint-disable-next-line no-control-regex
const NOISE = /[\u0000-\u001f\u007f‎‏‪-‮]/g;

/** `00447911123456` is `+447911123456`: the international prefix most of the world dials. */
function withPlus(text: string): string {
  const t = text.replace(NOISE, '').trim();
  return t.startsWith('00') ? `+${t.slice(2)}` : t;
}

/**
 * A valid phone in E.164, or null.
 *
 * A number written with its country code (`+` or `00`) is read on its own.
 * One written the way people write it at home (`0803 123 4567`) is read
 * against `defaultCountry`, the country the person chose, so a Nigerian
 * number typed with its leading 0 works when Nigeria is chosen. With neither
 * a code nor a country it is null: a local number says nothing about where it
 * is.
 */
export function parseInternationalPhone(
  raw: unknown,
  defaultCountry?: string | null,
): ParsedPhone | null {
  if (typeof raw !== 'string') return null;
  const text = withPlus(raw);
  if (text === '' || text.length > 40) return null;
  const international = text.startsWith('+');
  const country =
    defaultCountry && getCountries().includes(defaultCountry as CountryCode)
      ? (defaultCountry as CountryCode)
      : undefined;
  if (!international && !country) return null;
  const parsed = parsePhoneNumberFromString(
    text,
    international ? undefined : country,
  );
  if (!parsed || !parsed.isValid()) return null;
  return {
    e164: parsed.number,
    callingCode: parsed.countryCallingCode,
    nationalNumber: parsed.nationalNumber,
    countryCode: parsed.country ?? null,
  };
}

/** True when `raw` is a valid number in E.164 or `00` form, or a national form under `defaultCountry`. */
export function isValidInternationalPhone(
  raw: unknown,
  defaultCountry?: string | null,
): boolean {
  return parseInternationalPhone(raw, defaultCountry) !== null;
}

/** Calling code to the one country that uses it, for the codes with exactly one. */
const SOLE_COUNTRY = (() => {
  const seen = new Map<string, string[]>();
  for (const c of getCountries()) {
    const code = getCountryCallingCode(c);
    seen.set(code, [...(seen.get(code) ?? []), c]);
  }
  const sole = new Map<string, string>();
  for (const [code, list] of seen)
    if (list.length === 1) sole.set(code, list[0]);
  return sole;
})();

/**
 * The country a phone number belongs to, or null when it has no country code
 * (`08031234567` says nothing) or the code is shared and the number does not
 * tell which (+44 is Britain, Guernsey, Jersey and the Isle of Man; the
 * number's own digits decide when they can). A number that is not valid still
 * gives its country when the code has only one (`+234 80` is Nigeria): this
 * reads where a number is from, not whether it works.
 */
export function phoneCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = withPlus(raw);
  if (!text.startsWith('+')) return null;
  const parsed = parsePhoneNumberFromString(text);
  if (!parsed) return null;
  return parsed.country ?? SOLE_COUNTRY.get(parsed.countryCallingCode) ?? null;
}
