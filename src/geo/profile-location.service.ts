import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  GeoService,
  type LocationInput,
  type LocationWrite,
} from './geo.service';
import { phoneCountryCode } from './phone';
import type { CountrySource, MeLocationView } from './geo.types';

/**
 * What WAWU ID's token says about where a person is. `countryCode` is the ISO
 * 3166-1 alpha-2 claim GEO-01 added to WAWU ID (wawu-id `wmt/GEO-01`,
 * 7fb7dea: "NG", or null for an account that never said); `country` is the
 * older free text sign-up has always sent ("Nigeria", "NG", "United
 * Kingdom") and stays the fallback for a token made before GEO-01. Either may
 * be missing, null or not text at all; anything that is not text is read as
 * not given. `src/common/**` is fenced, so these are read off the token as
 * they arrive and not added to the claims interface.
 */
export interface IdentityGeoClaims {
  countryCode?: unknown;
  country?: unknown;
  phone?: unknown;
}

/** The structured location columns as stored. */
export interface StoredPlace {
  countryCode: string | null;
  regionCode: string | null;
  regionName: string | null;
  city: string | null;
  countrySource: string | null;
}

const EMPTY: StoredPlace = {
  countryCode: null,
  regionCode: null,
  regionName: null,
  city: null,
  countrySource: null,
};

const PLACE_SELECT = {
  countryCode: true,
  regionCode: true,
  regionName: true,
  city: true,
  countrySource: true,
} as const;

/**
 * A person's structured place on ProfileDetails (GEO-02, R-85): what they
 * chose, and the country WAWU ID or their phone gives until they choose.
 */
@Injectable()
export class ProfileLocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
  ) {}

  async stored(wawuUserId: string): Promise<StoredPlace> {
    const row = await this.prisma.profileDetails.findUnique({
      where: { wawuUserId },
      select: PLACE_SELECT,
    });
    return row ?? EMPTY;
  }

  /**
   * Checks a profile write against the lists and answers the columns to save
   * with it. A person who saves any of the four has chosen their place, so
   * the country is theirs from then on (source `profile`); with no country
   * left, there is no source.
   */
  prepare(
    input: LocationInput,
    stored: StoredPlace,
  ): LocationWrite & { countrySource?: CountrySource | null } {
    const write = this.geo.checkLocation(input, stored);
    if (Object.keys(write).length === 0) return write;
    const country =
      write.countryCode !== undefined ? write.countryCode : stored.countryCode;
    return { ...write, countrySource: country === null ? null : 'profile' };
  }

  /**
   * The people in a country (and region): every `wawuUserId` whose structured
   * place says so. Null when no filter was asked for, so a caller can tell
   * "no filter" from "nobody". An unknown country or region is a 400.
   */
  async idsInPlace(
    countryCode: string | undefined,
    regionCode: string | undefined,
  ): Promise<string[] | null> {
    if (countryCode === undefined && regionCode === undefined) return null;
    const where = this.geo.checkFilter(countryCode, regionCode);
    if (where.countryCode === undefined && where.regionCode === undefined) {
      return null;
    }
    const rows = await this.prisma.profileDetails.findMany({
      where,
      select: { wawuUserId: true },
    });
    return rows.map((r) => r.wawuUserId);
  }

  /** The country WAWU ID holds for the account, as an ISO code, or null. */
  wawuIdCountry(claims: IdentityGeoClaims): string | null {
    if (typeof claims.countryCode === 'string') {
      const byCode = this.geo.country(claims.countryCode);
      if (byCode) return byCode.code;
    }
    return this.geo.countryFromText(claims.country);
  }

  /**
   * The country the account's own data gives, and which it came from: the one
   * WAWU ID holds first, else the phone's, else none. The same order `me()`
   * applies.
   */
  derived(claims: IdentityGeoClaims): {
    countryCode: string | null;
    source: 'wawu_id' | 'phone' | null;
  } {
    const wawuId = this.wawuIdCountry(claims);
    if (wawuId !== null) return { countryCode: wawuId, source: 'wawu_id' };
    const phone = phoneCountryCode(claims.phone);
    if (phone !== null) return { countryCode: phone, source: 'phone' };
    return { countryCode: null, source: null };
  }

  /** People this process has already looked at once (see `noteSignedIn`). */
  private readonly looked = new Set<string>();
  private static readonly LOOKED_CAP = 50_000;

  /**
   * GEO-FILL (R-143): the first time this process sees a signed-in person it
   * looks, once, at whether the Hub has a country for them, and if not
   * records the one their token gives, exactly as `me()` does, so the
   * dashboard counts people who never open the phone app.
   *
   * Never awaited by the caller and never throws: it adds nothing to the
   * request's time, and a failure leaves the person's request untouched (the
   * daily fill covers them). A person whose token gives no country costs no
   * read at all.
   */
  noteSignedIn(wawuUserId: string, claims: IdentityGeoClaims): void {
    if (this.looked.has(wawuUserId)) return;
    if (this.looked.size >= ProfileLocationService.LOOKED_CAP) {
      this.looked.clear();
    }
    this.looked.add(wawuUserId);
    void this.recordIfMissing(wawuUserId, claims).catch(() => {
      this.looked.delete(wawuUserId);
    });
  }

  /** Records the token's country when the Hub holds none for the person. */
  async recordIfMissing(
    wawuUserId: string,
    claims: IdentityGeoClaims,
  ): Promise<boolean> {
    if (this.derived(claims).countryCode === null) return false;
    const place = await this.stored(wawuUserId);
    if (place.countryCode !== null) return false;
    await this.me(wawuUserId, claims);
    return true;
  }

  /**
   * The signed-in person's place. Where they have not chosen a country, the
   * one WAWU ID holds (else their phone's) is recorded first, so the
   * dashboard counts everyone who opens the app and not only those who edit
   * a profile. A chosen country is never replaced.
   */
  async me(
    wawuUserId: string,
    claims: IdentityGeoClaims,
  ): Promise<MeLocationView> {
    const wawuId = this.wawuIdCountry(claims);
    const phone = phoneCountryCode(claims.phone);
    let place = await this.stored(wawuUserId);

    const chosen =
      place.countryCode !== null &&
      place.countrySource !== 'wawu_id' &&
      place.countrySource !== 'phone';
    const derived = wawuId ?? phone;
    if (!chosen && derived !== null) {
      const source: CountrySource = wawuId !== null ? 'wawu_id' : 'phone';
      if (place.countryCode !== derived || place.countrySource !== source) {
        // Where the country is not the person's own it may not agree with a region
        // saved under another country: that region goes with it.
        const sameCountry = place.countryCode === derived;
        await this.prisma.profileDetails.upsert({
          where: { wawuUserId },
          update: {
            countryCode: derived,
            countrySource: source,
            ...(sameCountry ? {} : { regionCode: null, regionName: null }),
          },
          create: { wawuUserId, countryCode: derived, countrySource: source },
        });
        place = await this.stored(wawuUserId);
      }
    }

    const country = this.geo.country(place.countryCode);
    return {
      countryCode: country?.code ?? null,
      countryName: country?.name ?? null,
      countrySource: country
        ? ((place.countrySource ?? 'profile') as CountrySource)
        : null,
      regionCode: place.regionCode,
      regionName: place.regionName,
      city: place.city,
      wawuIdCountryCode: wawuId,
      phoneCountryCode: phone,
    };
  }
}
