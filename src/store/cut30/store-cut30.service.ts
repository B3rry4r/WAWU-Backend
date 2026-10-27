import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import type { StoreCut30Switch } from '../../../generated/prisma/client';
import { StorePlatform } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isUniqueViolation } from '../../money/prisma-unique';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { StoreAdminNoticeService } from '../payout/store-admin-notice.service';
import { buyProductId, type LadderStep, STORE_LADDER } from '../store-ladder';
import { STORE_LADDER_30 } from './store-ladder-30';
import { StorePriceSync, type PriceSyncResult } from './store-price-sync';
import {
  dollars,
  lagosYear,
  lagosYearStart,
  proceedsKoboOf,
  usdCentsOf,
} from './store-proceeds';
import { StoreUsdRateService } from './store-usd-rate.service';

export const CUT30_THRESHOLD_KEY = 'store.cut30_threshold_usd';

/** The store's cut once it is on the 30% ladder, in basis points (recorded on each purchase as WAWU's own net). */
export const CUT30_FEE_BPS = 3000;

const STORE_NAME: Record<StorePlatform, string> = {
  android: 'Google Play',
  ios: 'the App Store',
};

/** One store as the dashboard reads it. */
export interface StoreCut30StatusView {
  platform: StorePlatform;
  year: number;
  /** WAWU's proceeds from this store so far this year, in US cents. */
  totalUsdCents: number;
  thresholdUsdCents: number;
  /** The ladder the `wawu.buy.*` prices are on: 15 or 30. */
  ladder: 15 | 30;
  crossedAt: string | null;
  /** What was done in the store itself when the switch was made: done, partial, failed or no_keys. */
  storeSync: string | null;
}

export interface StoreCut30SwitchBackView {
  platform: StorePlatform;
  ladder: 15;
  /** done, partial, failed or no_keys. When it is not done, the owner changes the rest by hand. */
  storeSync: PriceSyncResult['state'];
  /** The store product ids still to change by hand in the store. */
  byHand: string[];
}

/**
 * The store's cut from 15% to 30% (task STORE-CUT30, R-101 point 9).
 *
 * The Hub keeps each store's calendar-year total (Africa/Lagos) of WAWU's
 * store proceeds in US dollars: one `StoreProceedsEntry` per granted production
 * purchase, converted once at the Hub's FX source (`StoreUsdRateService`).
 * Refunded and revoked purchases stop counting. When a store's total reaches
 * `store.cut30_threshold_usd` (default 900,000), that store's `wawu.buy.*`
 * rows switch, once for the year, to the 30% prices (`STORE_LADDER_30`), so
 * `GET /prices` shows them; WAWU receives at least the list price either way
 * and the creator keeps exactly 85% of it. The store itself is changed through
 * its API only when the server has the keys (`StorePriceSync`); without them
 * the owner's notice says to change the prices by hand. The total starts again
 * on 1 January; the move back to 15% is an admin action (`switchBack`), never
 * automatic.
 *
 * Idempotent and safe between servers: the entry is unique per purchase, the
 * switch is unique per store and year, and the notice per switch.
 */
@Injectable()
export class StoreCut30Service {
  private readonly logger = new Logger(StoreCut30Service.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: StoreUsdRateService,
    private readonly sync: StorePriceSync,
    private readonly notices: StoreAdminNoticeService,
    private readonly settings: PlanSettingsService,
  ) {}

  /** Every 5 minutes: count what is new, then see whether a store has crossed. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'store-cut30' })
  async sweep(
    now = new Date(),
  ): Promise<{ counted: number; switched: StorePlatform[] }> {
    const out = { counted: 0, switched: [] as StorePlatform[] };
    if (this.running) return out;
    this.running = true;
    try {
      out.counted = await this.countNew(now);
      for (const platform of [StorePlatform.android, StorePlatform.ios]) {
        if (await this.check(platform, now)) out.switched.push(platform);
      }
    } catch (e) {
      this.logger.error(
        `store cut sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
    return out;
  }

  /** The thresholds in US cents. */
  private thresholdCents(): bigint {
    return BigInt(this.settings.number(CUT30_THRESHOLD_KEY)) * 100n;
  }

  /** Makes an entry for each granted production purchase of this year that has none. Returns how many. */
  async countNew(now: Date): Promise<number> {
    const year = lagosYear(now);
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p."id" FROM "StorePurchase" p
       WHERE p."status" = 'granted' AND LOWER(p."environment") = 'production'
         AND p."purchasedAt" >= ${lagosYearStart(year)}
         AND NOT EXISTS (SELECT 1 FROM "StoreProceedsEntry" e WHERE e."storePurchaseId" = p."id")
       ORDER BY p."purchasedAt" ASC
       LIMIT 500`);
    if (ids.length === 0) return 0;
    const rate = await this.rates.current(now);
    if (rate === null) return 0;
    const rows = await this.prisma.storePurchase.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
    });
    const data: Prisma.StoreProceedsEntryCreateManyInput[] = [];
    for (const p of rows) {
      const kobo = proceedsKoboOf(p);
      if (kobo === null) continue;
      data.push({
        storePurchaseId: p.id,
        platform: p.platform,
        year: lagosYear(p.purchasedAt),
        proceedsKobo: kobo,
        usdCents: usdCentsOf(kobo, rate),
        rateKobo: rate.rateKobo,
        rateCents: rate.rateCents,
        rateSource: rate.source,
      });
    }
    if (data.length === 0) return 0;
    const { count } = await this.prisma.storeProceedsEntry.createMany({
      data,
      skipDuplicates: true,
    });
    return count;
  }

  /** A store's proceeds for a year, in US cents, from purchases that still stand. */
  async totalCents(platform: StorePlatform, year: number): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<
      Array<{ total: string }>
    >(Prisma.sql`
      SELECT COALESCE(SUM(e."usdCents"), 0)::text AS "total"
        FROM "StoreProceedsEntry" e
        JOIN "StorePurchase" p ON p."id" = e."storePurchaseId"
       WHERE e."platform" = ${platform}::"StorePlatform" AND e."year" = ${year}
         AND p."status" = 'granted'`);
    return BigInt(rows[0]?.total ?? '0');
  }

  /**
   * Switches a store the first time its total reaches the threshold in a year,
   * and finishes a switch whose notice was not written. True when this call
   * made the switch.
   */
  private async check(platform: StorePlatform, now: Date): Promise<boolean> {
    const year = lagosYear(now);
    const threshold = this.thresholdCents();
    const existing = await this.prisma.storeCut30Switch.findUnique({
      where: { platform_year: { platform, year } },
    });
    if (existing) {
      if (existing.noticedAt === null) await this.finish(existing);
      return false;
    }
    const total = await this.totalCents(platform, year);
    if (total < threshold) return false;
    let row: StoreCut30Switch;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const before = await tx.storePlatformSetting.findUnique({
          where: { platform },
          select: { storeFeeBps: true },
        });
        const made = await tx.storeCut30Switch.create({
          data: {
            platform,
            year,
            totalUsdCents: total,
            thresholdUsdCents: threshold,
            priorFeeBps: before?.storeFeeBps ?? null,
          },
        });
        await this.setPrices(tx, platform, STORE_LADDER_30);
        // WAWU's own recorded nets are true from now on (the store keeps 30%).
        // Every creator and host share is still worked on the cut from before
        // (`StoreAvailability.shareFeeBps`, recorded as `shareFeeBps` on each
        // purchase), so nobody but WAWU feels the extra cut.
        await tx.storePlatformSetting.upsert({
          where: { platform },
          create: { platform, storeFeeBps: CUT30_FEE_BPS },
          update: { storeFeeBps: CUT30_FEE_BPS },
        });
        return made;
      });
    } catch (e) {
      // Another server switched this store first: theirs stands and they tell the owner.
      if (isUniqueViolation(e)) return false;
      throw e;
    }
    await this.finish(row);
    return true;
  }

  /** Writes a store's `wawu.buy.*` store prices from a ladder, in the transaction that records why. */
  private async setPrices(
    tx: Prisma.TransactionClient,
    platform: StorePlatform,
    ladder: readonly LadderStep[],
  ): Promise<void> {
    for (const step of ladder) {
      await tx.storeProduct.updateMany({
        where: {
          platform,
          kind: 'buy',
          storeProductId: buyProductId(step.listNaira),
        },
        data: { storePriceKobo: step.storeNaira * 100 },
      });
    }
  }

  /**
   * After the prices are switched: change the store itself when the keys are
   * set (a network call, nothing held), then tell the owner once. Run again by
   * the next sweep if the notice was not written, so a server that died between
   * the two leaves nothing undone; changing a price again is the same price.
   */
  private async finish(row: StoreCut30Switch): Promise<void> {
    const sync =
      row.storeSync === null
        ? await this.sync.apply(row.platform, STORE_LADDER_30)
        : null;
    const state = sync?.state ?? row.storeSync;
    if (sync !== null) {
      await this.prisma.storeCut30Switch.updateMany({
        where: { id: row.id, storeSync: null },
        data: { storeSync: sync.state },
      });
    }
    const store = STORE_NAME[row.platform];
    const upper = store.charAt(0).toUpperCase() + store.slice(1);
    const allIds = STORE_LADDER_30.map((s) => buyProductId(s.listNaira));
    // No keys: all 25 are for the owner to change by hand. Done: none. Partly
    // or wholly failed: the ones that were not changed (all of them when the
    // sync result is no longer known).
    const byHand =
      state === 'no_keys'
        ? allIds
        : state === 'done'
          ? []
          : (sync?.failed ?? allIds);
    const ladder = STORE_LADDER_30.map((s) => ({
      productId: buyProductId(s.listNaira),
      storeNaira: s.storeNaira,
    }));
    const head = `${upper} reached ${dollars(row.thresholdUsdCents)} of WAWU proceeds for ${row.year} (the Hub counted ${dollars(row.totalUsdCents)}), so its cut is now 30%. The wawu.buy prices on the price list show the 30% ladder. Creators still keep exactly 85% of the list price.`;
    let tail: string;
    if (state === 'done') {
      tail = `WAWU changed all ${STORE_LADDER_30.length} prices in ${store} itself.`;
    } else if (state === 'no_keys') {
      tail = `The server has no keys to change prices in ${store}, so change the ${STORE_LADDER_30.length} wawu.buy products by hand there. The new Nigeria prices are in the details of this notice.`;
    } else {
      tail = `WAWU could not change ${byHand.length} of the ${STORE_LADDER_30.length} prices in ${store}. Change these by hand: ${byHand.join(', ')}. The new Nigeria prices are in the details of this notice.`;
    }
    const wrote = await this.notices.once({
      kind: 'store_cut30',
      noticeKey: `store_cut30:${row.platform}:${row.year}`,
      title: `${upper} prices moved to the 30% ladder`,
      body: `${head} ${tail} At the new year, move the prices back to 15% from the dashboard.`,
      data: {
        platform: row.platform,
        year: row.year,
        totalUsdCents: row.totalUsdCents.toString(),
        thresholdUsdCents: row.thresholdUsdCents.toString(),
        storeSync: state,
        byHand,
        ladder,
      },
    });
    await this.prisma.storeCut30Switch.updateMany({
      where: { id: row.id, noticedAt: null },
      data: { noticedAt: new Date() },
    });
    if (wrote)
      this.logger.warn(
        `store cut: ${row.platform} moved to the 30% ladder (${dollars(row.totalUsdCents)} counted, store sync ${state ?? 'unknown'}); the owner has been told`,
      );
  }

  /** Where each store stands: the year's total, the threshold and the ladder its prices are on. */
  async status(now = new Date()): Promise<StoreCut30StatusView[]> {
    const year = lagosYear(now);
    const threshold = this.thresholdCents();
    const out: StoreCut30StatusView[] = [];
    for (const platform of [StorePlatform.android, StorePlatform.ios]) {
      const [total, latest] = await Promise.all([
        this.totalCents(platform, year),
        this.prisma.storeCut30Switch.findFirst({
          where: { platform },
          orderBy: [{ year: 'desc' }],
        }),
      ]);
      out.push({
        platform,
        year,
        totalUsdCents: Number(total),
        thresholdUsdCents: Number(threshold),
        ladder: latest !== null && latest.backAt === null ? 30 : 15,
        crossedAt: latest?.crossedAt.toISOString() ?? null,
        storeSync: latest?.storeSync ?? null,
      });
    }
    return out;
  }

  /**
   * The admin action at the new year (or any time): a store's `wawu.buy.*`
   * prices go back to the 15% ladder. Never automatic. The store itself is
   * changed when the keys are set; what could not be is named for the owner to
   * change by hand.
   */
  async switchBack(
    platform: StorePlatform,
    adminId: string,
  ): Promise<StoreCut30SwitchBackView> {
    const open = await this.prisma.storeCut30Switch.findFirst({
      where: { platform, backAt: null },
      orderBy: [{ year: 'desc' }],
    });
    if (open === null)
      throw new ConflictException('That store is already on the 15% prices.');
    await this.prisma.$transaction(async (tx) => {
      const marked = await tx.storeCut30Switch.updateMany({
        where: { id: open.id, backAt: null },
        data: { backAt: new Date(), backByAdminId: adminId },
      });
      if (marked.count === 0)
        throw new ConflictException('That store is already on the 15% prices.');
      await this.setPrices(tx, platform, STORE_LADDER);
      // The cut the store had before the switch is put back (none: the
      // config's, 15% unless the server sets another).
      await tx.storePlatformSetting.updateMany({
        where: { platform, storeFeeBps: CUT30_FEE_BPS },
        data: { storeFeeBps: open.priorFeeBps, updatedBy: adminId },
      });
    });
    const sync = await this.sync.apply(platform, STORE_LADDER);
    return {
      platform,
      ladder: 15,
      storeSync: sync.state,
      byHand:
        sync.state === 'no_keys'
          ? STORE_LADDER.map((s) => buyProductId(s.listNaira))
          : sync.failed,
    };
  }
}
