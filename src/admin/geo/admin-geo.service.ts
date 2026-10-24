import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GeoService } from '../../geo/geo.service';
import type {
  AdminGeoCountryCount,
  AdminGeoCountsView,
  AdminGeoRegionCount,
} from '../../geo/geo.types';
import type { AdminGeoCountsQueryDto } from './dto/admin-geo-counts-query.dto';

interface CountRow {
  countryCode: string | null;
  regionCode: string | null;
  regionName: string | null;
  people: number;
  creators: number;
}

/**
 * GET /admin/geo/counts (GEO-02, R-85): how many accounts are in each country
 * and, within it, each region, and how many of them are creators.
 *
 * Counted from every UserProfile, so an account with no place yet is counted
 * under `unknown` and the lines always add up to `people`. One grouped query;
 * the country and region names come from the lists, not from the rows, except
 * a free-text region (a country ISO divides into nothing), which has no code.
 */
@Injectable()
export class AdminGeoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
  ) {}

  async counts(query: AdminGeoCountsQueryDto): Promise<AdminGeoCountsView> {
    const only = query.countryCode
      ? this.geo.checkFilter(query.countryCode, undefined).countryCode
      : undefined;

    const rows = await this.prisma.$queryRaw<
      Array<{
        countryCode: string | null;
        regionCode: string | null;
        regionName: string | null;
        people: bigint | number;
        creators: bigint | number;
      }>
    >`
      SELECT d."countryCode" AS "countryCode",
             d."regionCode" AS "regionCode",
             MIN(d."regionName") AS "regionName",
             COUNT(*) AS "people",
             COUNT(*) FILTER (WHERE p."accountType" = 'creator') AS "creators"
      FROM "UserProfile" p
      LEFT JOIN "ProfileDetails" d ON d."wawuUserId" = p."wawuUserId"
      GROUP BY d."countryCode", d."regionCode", CASE WHEN d."regionCode" IS NULL THEN d."regionName" END
    `;
    const lines: CountRow[] = rows.map((r) => ({
      countryCode: r.countryCode,
      regionCode: r.regionCode,
      regionName: r.regionName,
      people: Number(r.people),
      creators: Number(r.creators),
    }));

    const total = { people: 0, creators: 0 };
    const unknown = { people: 0, creators: 0 };
    const byCountry = new Map<string, AdminGeoCountryCount>();
    for (const line of lines) {
      total.people += line.people;
      total.creators += line.creators;
      if (line.countryCode === null) {
        unknown.people += line.people;
        unknown.creators += line.creators;
        continue;
      }
      if (only !== undefined && line.countryCode !== only) continue;
      let country = byCountry.get(line.countryCode);
      if (!country) {
        country = {
          countryCode: line.countryCode,
          countryName:
            this.geo.country(line.countryCode)?.name ?? line.countryCode,
          people: 0,
          creators: 0,
          regions: [],
        };
        byCountry.set(line.countryCode, country);
      }
      country.people += line.people;
      country.creators += line.creators;
      country.regions.push(this.regionLine(line));
    }

    const countries = [...byCountry.values()];
    for (const c of countries) c.regions.sort(byPeople);
    countries.sort(byPeople);
    return { ...total, unknown, countries };
  }

  private regionLine(line: CountRow): AdminGeoRegionCount {
    const listed =
      line.regionCode === null
        ? undefined
        : this.geo
            .regions(line.countryCode)
            ?.find((r) => r.code === line.regionCode);
    return {
      regionCode: line.regionCode,
      regionName: listed?.name ?? line.regionName,
      people: line.people,
      creators: line.creators,
    };
  }
}

const byPeople = (a: { people: number }, b: { people: number }) =>
  b.people - a.people;
