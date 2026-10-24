import { Controller, Get, Header, Param } from '@nestjs/common';
import { GeoService } from './geo.service';
import type { GeoCountryList, GeoRegionList } from './geo.types';

/**
 * The country and region lists (GEO-02, R-85): every ISO 3166-1 country with
 * its calling code, flag and an example number, and every country's ISO 3166-2
 * regions. The app never carries a list of its own; it reads these.
 *
 * PUBLIC. A sign-up screen needs the lists before anyone has a token, and
 * nothing in them is about a person. They come from a pinned package that is
 * read at boot, so they change only with a release: a day's cache is safe,
 * and the response carries an ETag (Express) beside the Cache-Control.
 *
 * `geo` is a first segment no other controller declares.
 */
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** Every country, A to Z by name. */
  @Get('countries')
  @Header('Cache-Control', 'public, max-age=86400')
  countries(): GeoCountryList {
    return { items: [...this.geo.countries()] };
  }

  /**
   * One country's ISO 3166-2 regions, A to Z by name. `code` is the country's
   * ISO alpha-2 code in any case. 404 `country_not_found` for a code that is
   * not on the list; 200 with no items for a country ISO divides into nothing.
   */
  @Get('countries/:code/regions')
  @Header('Cache-Control', 'public, max-age=86400')
  regions(@Param('code') code: string): GeoRegionList {
    const country = this.geo.country(code);
    if (!country) throw this.geo.unknownCountry();
    return {
      countryCode: country.code,
      items: [...(this.geo.regions(country.code) ?? [])],
    };
  }
}
