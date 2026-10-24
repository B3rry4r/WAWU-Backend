import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { englishNames } from './country-names';
import { geoData } from './geo-data';
import type { GeoCountryView, GeoRegionView } from './geo.types';

/** The longest city or free-text region name saved. PROVISIONAL(GEO-CITY-MAX, owner=YOU, why=no ruling names a limit; 80 fits the longest place names in use). */
export const CITY_MAX_LENGTH = 80;

/** What a write to the structured location may carry. A key left out (undefined) is left as it is; null or "" clears. */
export interface LocationInput {
  countryCode?: string | null;
  regionCode?: string | null;
  regionName?: string | null;
  city?: string | null;
}

/** What is saved now, so a partial write can be checked against it. */
export interface StoredLocation {
  countryCode: string | null;
  regionCode: string | null;
  regionName: string | null;
  city: string | null;
}

/** The columns to write: only the keys that change. */
export type LocationWrite = Partial<StoredLocation>;

/** A 400 with a stable `reason.code` the app can switch on (CONVENTIONS section 3). */
function refuse(code: string, message: string): BadRequestException {
  return new BadRequestException({ message, reason: { code, message } });
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
};

/** A name compared without case, accents or punctuation: "Cote d'Ivoire" finds "Côte d’Ivoire". */
export function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Names people write that are not the list's name. WAWU ID's sign-up takes
 * the country as free text, so "UK", "USA" and "Ivory Coast" all arrive.
 */
const ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  america: 'US',
  'united states of america': 'US',
  uae: 'AE',
  'ivory coast': 'CI',
  'south korea': 'KR',
  'korea south': 'KR',
  'north korea': 'KP',
  russia: 'RU',
  'czech republic': 'CZ',
  turkey: 'TR',
  turkiye: 'TR',
  swaziland: 'SZ',
  burma: 'MM',
  'cape verde': 'CV',
  'democratic republic of the congo': 'CD',
  'dr congo': 'CD',
  drc: 'CD',
  'republic of the congo': 'CG',
  'congo brazzaville': 'CG',
  vietnam: 'VN',
  laos: 'LA',
  syria: 'SY',
  iran: 'IR',
  tanzania: 'TZ',
  bolivia: 'BO',
  venezuela: 'VE',
  moldova: 'MD',
  macedonia: 'MK',
  palestine: 'PS',
  brunei: 'BN',
  'the gambia': 'GM',
  'the bahamas': 'BS',
  'east timor': 'TL',
  holland: 'NL',
  'the netherlands': 'NL',
  'hong kong sar': 'HK',
  'vatican city': 'VA',
  'holy see': 'VA',
};

@Injectable()
export class GeoService {
  private nameIndex: Map<string, string> | null = null;

  /** Every country, A to Z. Shared: never mutate. */
  countries(): readonly GeoCountryView[] {
    return geoData().countries;
  }

  /** One country by ISO alpha-2 (any case), or null. */
  country(code: unknown): GeoCountryView | null {
    if (typeof code !== 'string') return null;
    return geoData().byCode.get(code.trim().toUpperCase()) ?? null;
  }

  /** A country's regions (A to Z), or null when the country is unknown. [] when ISO lists none. */
  regions(countryCode: unknown): readonly GeoRegionView[] | null {
    const c = this.country(countryCode);
    return c ? (geoData().regions.get(c.code) ?? []) : null;
  }

  /** The 404 for a country that is not in the list. */
  unknownCountry(): NotFoundException {
    const message = 'We do not have a country with that code.';
    return new NotFoundException({
      message,
      reason: { code: 'country_not_found', message },
    });
  }

  /**
   * A country from text a person or WAWU ID wrote: an alpha-2 or alpha-3
   * code, the list's name, the name the platform's own locale data uses, or a
   * common alias. Null when it is none of those.
   */
  countryFromText(text: unknown): string | null {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (t === '' || t.length > 80) return null;
    if (/^[A-Za-z]{2}$/.test(t)) {
      const byCode = this.country(t)?.code;
      if (byCode) return byCode;
    }
    if (/^[A-Za-z]{3}$/.test(t)) {
      const byAlpha3 = geoData().alpha3.get(t.toUpperCase());
      if (byAlpha3) return byAlpha3;
    }
    const index = this.names();
    return index.get(foldName(t)) ?? null;
  }

  private names(): Map<string, string> {
    if (this.nameIndex) return this.nameIndex;
    const index = new Map<string, string>();
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const c of this.countries()) {
      index.set(foldName(c.name), c.code);
      for (const other of englishNames(c.code))
        index.set(foldName(other), c.code);
      index.set(foldName(c.code), c.code);
      try {
        const cldr = display.of(c.code);
        if (cldr && cldr !== c.code) index.set(foldName(cldr), c.code);
      } catch {
        // a code the platform does not know: the list's own name already stands
      }
    }
    for (const [alias, code] of Object.entries(ALIASES)) {
      if (this.country(code)) index.set(foldName(alias), code);
    }
    this.nameIndex = index;
    return index;
  }

  /**
   * Checks a write to the structured location against the lists and answers
   * the columns to save. The rules, in one place:
   *
   *  - a country must be on the list (any case in, upper case out);
   *  - a region needs a country, and must be one of that country's regions
   *    (the full code "NG-LA", or its tail "LA", or its name "Lagos"); its
   *    name is then the list's, and a name sent beside a code must be that code's;
   *  - a country with no regions on the list takes a region as free text;
   *  - changing or clearing the country clears a region that was not sent
   *    again, since it belonged to the old country;
   *  - the city is free text, trimmed, up to CITY_MAX_LENGTH;
   *  - null or "" clears a key; a key left out is left as it is.
   */
  checkLocation(input: LocationInput, stored: StoredLocation): LocationWrite {
    const write: LocationWrite = {};

    let country = stored.countryCode;
    if (input.countryCode !== undefined) {
      const raw = clean(input.countryCode);
      if (raw === null) {
        country = null;
      } else {
        const found = this.country(raw);
        if (!found) {
          throw refuse('country_invalid', 'Choose a country from the list.');
        }
        country = found.code;
      }
      write.countryCode = country;
    }

    const regionSent =
      input.regionCode !== undefined || input.regionName !== undefined;
    const countryChanged = country !== stored.countryCode;

    if (!regionSent) {
      if (
        countryChanged &&
        (stored.regionCode !== null || stored.regionName !== null)
      ) {
        write.regionCode = null;
        write.regionName = null;
      }
    } else {
      const code = clean(input.regionCode);
      const name = clean(input.regionName);
      if (code === null && name === null) {
        write.regionCode = null;
        write.regionName = null;
      } else {
        if (country === null) {
          throw refuse(
            'region_needs_country',
            'Choose a country before a region.',
          );
        }
        const list = this.regions(country) ?? [];
        if (list.length === 0) {
          if (code !== null) {
            throw refuse(
              'region_invalid',
              'That country has no list of regions. Type the region as text.',
            );
          }
          if (name!.length > CITY_MAX_LENGTH) {
            throw refuse('region_invalid', 'That region name is too long.');
          }
          write.regionCode = null;
          write.regionName = name;
        } else {
          const hit = this.findRegion(list, country, code, name);
          write.regionCode = hit.code;
          write.regionName = hit.name;
        }
      }
    }

    if (input.city !== undefined) {
      const city = clean(input.city);
      if (city !== null && city.length > CITY_MAX_LENGTH) {
        throw refuse(
          'city_too_long',
          `A city can be up to ${CITY_MAX_LENGTH} characters.`,
        );
      }
      write.city = city;
    }
    return write;
  }

  /**
   * Checks the country and region an admin list is filtered by. Both must be
   * on the lists (so a typo is a 400 and not an empty page); a region alone
   * carries its country in its code ("NG-LA"). Answers upper case values.
   */
  checkFilter(
    countryCode: string | undefined,
    regionCode: string | undefined,
  ): { countryCode?: string; regionCode?: string } {
    const out: { countryCode?: string; regionCode?: string } = {};
    let country: string | undefined;
    if (countryCode !== undefined && clean(countryCode) !== null) {
      const found = this.country(clean(countryCode));
      if (!found) {
        throw refuse('country_invalid', 'Choose a country from the list.');
      }
      country = found.code;
      out.countryCode = country;
    }
    const region = clean(regionCode);
    if (region !== null) {
      const upper = region.toUpperCase();
      const full =
        country && !upper.includes('-') ? `${country}-${upper}` : upper;
      const owner = full.split('-')[0];
      const list = this.regions(country ?? owner);
      const hit = list?.find((r) => r.code === full);
      if (!hit || (country !== undefined && owner !== country)) {
        throw refuse(
          'region_invalid',
          'Choose a region of that country from the list.',
        );
      }
      out.countryCode = owner;
      out.regionCode = hit.code;
    }
    return out;
  }

  private findRegion(
    list: readonly GeoRegionView[],
    country: string,
    code: string | null,
    name: string | null,
  ): GeoRegionView {
    if (code !== null) {
      const upper = code.toUpperCase();
      const full = upper.startsWith(`${country}-`)
        ? upper
        : `${country}-${upper}`;
      const hit = list.find((r) => r.code === full);
      if (!hit) {
        throw refuse(
          'region_invalid',
          'Choose a region of that country from the list.',
        );
      }
      if (name !== null && foldName(name) !== foldName(hit.name)) {
        throw refuse(
          'region_invalid',
          'That region name is not the one for that region code.',
        );
      }
      return hit;
    }
    const wanted = foldName(name!);
    // A name can be two places at different levels (a city and the province around
    // it): then it names neither, and the person is asked to choose by code.
    const matches = list.filter((r) => foldName(r.name) === wanted);
    const hit = matches.length === 1 ? matches[0] : undefined;
    if (!hit) {
      throw refuse(
        'region_invalid',
        matches.length > 1
          ? 'More than one region has that name. Choose it from the list.'
          : 'Choose a region of that country from the list.',
      );
    }
    return hit;
  }
}
