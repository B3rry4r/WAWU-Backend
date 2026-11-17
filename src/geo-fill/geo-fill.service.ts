import {
  BadGatewayException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileLocationService } from '../geo/profile-location.service';
import {
  WAWU_ID_USERS_MAX_IDS,
  WawuIdUsersClient,
} from '../identity-users/wawu-id-users.client';

/** What one fill did. `checked = filled + alreadyChosen + unknown`. */
export interface GeoFillReport {
  /** Hub accounts looked at. */
  checked: number;
  /** Accounts that got a country from this run. */
  filled: number;
  /** Accounts that already had a country (one a person chose, or one recorded before), left exactly as they were. */
  alreadyChosen: number;
  /** Accounts with no country that WAWU ID does not know, or that give none; left as they are. */
  unknown: number;
}

const BATCH = WAWU_ID_USERS_MAX_IDS;
/** A little after the app starts: let it finish booting and WAWU ID be reachable first. */
const STARTUP_DELAY_MS = 90_000;
const LOCK_KEY = 'geo-fill-countries';

/**
 * GEO-FILL (R-143): gives every Hub account a country for the dashboard's
 * counts.
 *
 * WHO. Every UserProfile with no country in ProfileDetails (no row, or a row
 * with none). An account that has any country is counted as `alreadyChosen`
 * and never read or written: a country a person chose is never replaced, and
 * one recorded earlier from WAWU ID or a phone is refreshed where `me()` does
 * it (the phone app's own call).
 *
 * HOW. In batches of 200 ids, WAWU ID is asked for the people (one call per
 * batch). The country is the one WAWU ID holds (source `wawu_id`), else the
 * phone's (source `phone`): the same order `ProfileLocationService.derived`
 * gives `me()`. A person WAWU ID does not know, or whose data gives no
 * country, is left alone and counted `unknown`; they are looked at again at
 * the next run.
 *
 * SAFE TWICE, SAFE AT ONCE. A write only lands while the row still has no
 * country (`updateMany ... countryCode IS NULL`, or an insert that the primary
 * key refuses if the row appeared), so a run that meets a country someone else
 * just set leaves it and counts it `alreadyChosen`. A second run finds nothing
 * left to fill. Two runs at once (two people pressing it, or a press during
 * the daily one) therefore never write the same account twice or touch a
 * chosen one.
 *
 * WHEN. By itself: once shortly after the app starts, then once a day (the
 * way SchedulerService runs its sweeps: `@Cron`, a failure is logged and
 * never stops the app). Across servers one at a time: the scheduled run takes
 * a transaction-scoped advisory lock and a server that does not get it does
 * nothing. The route runs the same `run()`.
 *
 * WAWU ID NOT REACHABLE. The run stops at the first batch it cannot read
 * (what was filled before stays) and says so: the route answers 502, the
 * schedule logs it and tries again at the next run.
 *
 * PRIVACY. Names, emails and phones are read to find a country and dropped;
 * nothing is stored or logged but the country.
 */
@Injectable()
export class GeoFillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GeoFillService.name);
  private startup: NodeJS.Timeout | null = null;
  private scheduledRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly places: ProfileLocationService,
    private readonly identity: WawuIdUsersClient,
  ) {}

  onApplicationBootstrap(): void {
    // A spec that boots the whole app must not fill its database behind its back.
    if (process.env.JEST_WORKER_ID !== undefined) return;
    if (process.env.NODE_ENV === 'test') return;
    this.startup = setTimeout(() => {
      this.startup = null;
      void this.scheduled();
    }, STARTUP_DELAY_MS);
    this.startup.unref();
  }

  onModuleDestroy(): void {
    if (this.startup) clearTimeout(this.startup);
    this.startup = null;
  }

  @Cron('23 2 * * *', { name: 'geo-fill-countries' })
  async daily(): Promise<void> {
    await this.scheduled();
  }

  /** The by-itself run: one at a time in this process and, by the lock, across servers. Never throws. */
  async scheduled(): Promise<void> {
    if (this.scheduledRunning) return;
    this.scheduledRunning = true;
    try {
      const report = await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) AS "locked"`;
          if (!rows[0]?.locked) return null;
          return this.run();
        },
        { timeout: 15 * 60_000, maxWait: 10_000 },
      );
      if (report) {
        this.logger.log(
          `Country fill: checked ${report.checked}, filled ${report.filled}, already had one ${report.alreadyChosen}, unknown ${report.unknown}.`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Country fill failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.scheduledRunning = false;
    }
  }

  /** One fill. Callable twice and at once; see the class comment. */
  async run(): Promise<GeoFillReport> {
    const [{ n }] = await this.prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT COUNT(*) AS "n"
      FROM "UserProfile" p
      JOIN "ProfileDetails" d ON d."wawuUserId" = p."wawuUserId"
      WHERE d."countryCode" IS NOT NULL`;
    const report: GeoFillReport = {
      checked: Number(n),
      filled: 0,
      alreadyChosen: Number(n),
      unknown: 0,
    };

    let after = '';
    for (;;) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT p."wawuUserId" AS "id"
        FROM "UserProfile" p
        LEFT JOIN "ProfileDetails" d ON d."wawuUserId" = p."wawuUserId"
        WHERE d."countryCode" IS NULL AND p."wawuUserId" > ${after}
        ORDER BY p."wawuUserId"
        LIMIT ${BATCH}`;
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      after = ids[ids.length - 1];

      const people = await this.identity.byIds(ids);
      if (people === null) {
        throw new BadGatewayException(
          'WAWU ID could not be reached, so no further countries were filled. Try again in a moment.',
        );
      }
      for (const id of ids) {
        report.checked += 1;
        const person = people.get(id);
        const derived = person
          ? this.places.derived({
              countryCode: person.countryCode,
              phone: person.phone,
            })
          : { countryCode: null, source: null };
        if (derived.countryCode === null || derived.source === null) {
          report.unknown += 1;
          continue;
        }
        const landed = await this.write(
          id,
          derived.countryCode,
          derived.source,
        );
        if (landed) report.filled += 1;
        else report.alreadyChosen += 1;
      }
      if (ids.length < BATCH) break;
    }
    return report;
  }

  /** True when this call set the country; false when the account got one in the meantime. */
  private async write(
    wawuUserId: string,
    countryCode: string,
    source: 'wawu_id' | 'phone',
  ): Promise<boolean> {
    // A region saved under another country goes with the change, as `me()` does.
    const updated = await this.prisma.profileDetails.updateMany({
      where: { wawuUserId, countryCode: null },
      data: {
        countryCode,
        countrySource: source,
        regionCode: null,
        regionName: null,
      },
    });
    if (updated.count > 0) return true;
    try {
      await this.prisma.profileDetails.create({
        data: { wawuUserId, countryCode, countrySource: source },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }
}
