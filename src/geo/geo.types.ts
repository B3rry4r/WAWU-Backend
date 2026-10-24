/**
 * The shapes GEO-02 (R-85) answers with: the country and region lists the app
 * never carries itself, and a person's own place.
 */

/** One country, ISO 3166-1, with what a phone field and a flag need. */
export interface GeoCountryView {
  /** ISO 3166-1 alpha-2, upper case: "NG". */
  code: string;
  /** English name: "Nigeria". */
  name: string;
  /**
   * The country calling code with its plus: "+234". Null for the few ISO
   * entries that have no telephone numbers (Antarctica, Bouvet Island ...),
   * which the app leaves out of a phone dropdown. Several countries share a
   * code ("+1"); the number typed under a chosen country says which.
   */
  dialCode: string | null;
  /** The flag as an emoji: "🇳🇬". */
  flag: string;
  /** A real mobile number of the country in E.164, for a field's hint: "+2348021234567". Null with no dial code. */
  exampleNumber: string | null;
  /** The same number as people write it at home: "0802 123 4567". Null with no dial code. */
  exampleNational: string | null;
  /** True when GET /geo/countries/{code}/regions has regions to pick from. */
  hasRegions: boolean;
}

/** GET /geo/countries. */
export interface GeoCountryList {
  /** Every ISO 3166-1 country, A to Z by name. */
  items: GeoCountryView[];
}

/** One ISO 3166-2 subdivision. */
export interface GeoRegionView {
  /** The full ISO 3166-2 code, upper case: "NG-LA". */
  code: string;
  /** English name: "Lagos". */
  name: string;
  /** What ISO calls it in that country: "State", "Province", "County", "Region" ... */
  type: string;
}

/** GET /geo/countries/{code}/regions. */
export interface GeoRegionList {
  /** The country asked for, upper case. */
  countryCode: string;
  /** Its subdivisions, A to Z by name. Empty for a country that ISO divides into nothing. */
  items: GeoRegionView[];
}

/** Where `countryCode` came from. */
export type CountrySource = 'profile' | 'wawu_id' | 'phone';

/** GET /me/location: the signed-in person's own place. */
export interface MeLocationView {
  /** Their country of residence: what they chose, else WAWU ID's, else the phone's. Null when none is known. */
  countryCode: string | null;
  /** The country's English name. */
  countryName: string | null;
  /** `profile` (they chose it), `wawu_id` or `phone`. Null with no country. */
  countrySource: CountrySource | null;
  /** Full ISO 3166-2 code, only ever set by the person. */
  regionCode: string | null;
  regionName: string | null;
  city: string | null;
  /** The country WAWU ID holds for the account (sign-up), whatever the person chose since. */
  wawuIdCountryCode: string | null;
  /** The country of the account's phone number. Best guess where countries share a code. */
  phoneCountryCode: string | null;
}

/** A person's place on an admin row. Every key is null for someone with no country or region yet. */
export interface AdminPlaceView {
  countryCode: string | null;
  regionCode: string | null;
  regionName: string | null;
  city: string | null;
  /** How the country got there: `profile`, `wawu_id` or `phone`. */
  countrySource: CountrySource | null;
}

/** One region's line in GET /admin/geo/counts. `regionCode` is null for the people of that country with no region. */
export interface AdminGeoRegionCount {
  regionCode: string | null;
  regionName: string | null;
  people: number;
  creators: number;
}

/** One country's line in GET /admin/geo/counts. */
export interface AdminGeoCountryCount {
  countryCode: string;
  countryName: string;
  people: number;
  creators: number;
  /** Most people first. Sums to `people`. */
  regions: AdminGeoRegionCount[];
}

/** GET /admin/geo/counts. */
export interface AdminGeoCountsView {
  /** Every account with a profile. */
  people: number;
  creators: number;
  /** Accounts whose country is not known yet (not chosen, and not yet read from WAWU ID or a phone). */
  unknown: { people: number; creators: number };
  /** Most people first. With `?countryCode=` only that country. */
  countries: AdminGeoCountryCount[];
}
