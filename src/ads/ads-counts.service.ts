import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  AdCampaignCounts,
  AdCountMismatch,
  AdCounts,
  AdDayCounts,
  AdDayRange,
} from './ads-counts.type';
import { requireDay } from './ads-day';

type Raw = Pick<AdCounts, 'views' | 'taps' | 'skips'>;

const withCtr = (c: Raw): AdCounts => ({
  views: c.views,
  taps: c.taps,
  skips: c.skips,
  ctr: c.views === 0 ? null : c.taps / c.views,
});

const dayText = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Task ADS-05. The read side of the counts, for the admin report (ADS-06) and
 * the dashboard (ADS-02). Reads only; it asks nothing about whether a campaign
 * exists, so the caller checks that first (an unknown id reads as zeros).
 *
 * Counts never change when a campaign is paused or ends: nothing here or in
 * the recorder looks at status when reading, and nothing deletes a row.
 */
@Injectable()
export class AdsCountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** One campaign: the totals over the span and each day inside it. */
  async forCampaign(
    campaignId: string,
    range: AdDayRange = {},
  ): Promise<AdCampaignCounts> {
    const rows = await this.prisma.adDailyTotal.findMany({
      where: { campaignId, day: this.dayFilter(range) },
      orderBy: { day: 'asc' },
      select: { day: true, views: true, taps: true, skips: true },
    });
    const days: AdDayCounts[] = rows.map((r) => ({
      day: dayText(r.day),
      views: r.views,
      taps: r.taps,
      skips: r.skips,
    }));
    return {
      campaignId,
      delivery: withCtr(sum(rows)),
      days,
    };
  }

  /**
   * Totals for many campaigns at once (the list view), keyed by campaign id.
   * Every id asked for is in the answer; one with nothing counted is zeros.
   */
  async totalsFor(
    campaignIds: string[],
    range: AdDayRange = {},
  ): Promise<Record<string, AdCounts>> {
    const out: Record<string, AdCounts> = {};
    for (const id of campaignIds)
      out[id] = withCtr({ views: 0, taps: 0, skips: 0 });
    if (campaignIds.length === 0) return out;
    const grouped = await this.prisma.adDailyTotal.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaignIds }, day: this.dayFilter(range) },
      _sum: { views: true, taps: true, skips: true },
    });
    for (const g of grouped) {
      out[g.campaignId] = withCtr({
        views: g._sum.views ?? 0,
        taps: g._sum.taps ?? 0,
        skips: g._sum.skips ?? 0,
      });
    }
    return out;
  }

  /**
   * The counts of every campaign together (or of just `campaignIds`) over the
   * span: the totals the summary report shows. Zeros and a null rate when
   * nothing was counted.
   */
  async summary(
    range: AdDayRange = {},
    campaignIds?: string[],
  ): Promise<AdCounts> {
    const agg = await this.prisma.adDailyTotal.aggregate({
      where: {
        ...(campaignIds ? { campaignId: { in: campaignIds } } : {}),
        day: this.dayFilter(range),
      },
      _sum: { views: true, taps: true, skips: true },
    });
    return withCtr({
      views: agg._sum.views ?? 0,
      taps: agg._sum.taps ?? 0,
      skips: agg._sum.skips ?? 0,
    });
  }

  /**
   * The days on which the stored daily totals differ from what the raw events
   * add up to. Empty when they match, which is always unless someone edited a
   * row by hand or an account purge has removed raw rows (the totals are kept:
   * they are what was invoiced).
   */
  async reconcile(campaignId: string): Promise<AdCountMismatch[]> {
    const totals = await this.prisma.adDailyTotal.findMany({
      where: { campaignId },
      select: { day: true, views: true, taps: true, skips: true },
    });
    const events = await this.prisma.adEvent.groupBy({
      by: ['day', 'type'],
      where: { campaignId },
      _count: { _all: true },
    });
    const fromEvents = new Map<string, Raw>();
    for (const e of events) {
      const key = dayText(e.day);
      const cur = fromEvents.get(key) ?? { views: 0, taps: 0, skips: 0 };
      if (e.type === 'view') cur.views += e._count._all;
      else if (e.type === 'tap') cur.taps += e._count._all;
      else cur.skips += e._count._all;
      fromEvents.set(key, cur);
    }
    const fromTotals = new Map<string, Raw>(
      totals.map((t) => [
        dayText(t.day),
        { views: t.views, taps: t.taps, skips: t.skips },
      ]),
    );
    const days = new Set([...fromEvents.keys(), ...fromTotals.keys()]);
    const zero: Raw = { views: 0, taps: 0, skips: 0 };
    const out: AdCountMismatch[] = [];
    for (const day of [...days].sort()) {
      const t = fromTotals.get(day) ?? zero;
      const e = fromEvents.get(day) ?? zero;
      if (t.views !== e.views || t.taps !== e.taps || t.skips !== e.skips) {
        out.push({ day, totals: t, events: e });
      }
    }
    return out;
  }

  private dayFilter(range: AdDayRange): { gte?: Date; lte?: Date } {
    const filter: { gte?: Date; lte?: Date } = {};
    if (range.from !== undefined) {
      filter.gte = new Date(`${requireDay(range.from)}T00:00:00.000Z`);
    }
    if (range.to !== undefined) {
      filter.lte = new Date(`${requireDay(range.to)}T00:00:00.000Z`);
    }
    return filter;
  }
}

function sum(rows: Raw[]): Raw {
  return rows.reduce(
    (a, r) => ({
      views: a.views + r.views,
      taps: a.taps + r.taps,
      skips: a.skips + r.skips,
    }),
    { views: 0, taps: 0, skips: 0 },
  );
}
