import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ADS_CLOCK, type AdsClock } from './ads-clock';
import { utcDay } from './ads-day';
import { servableCampaigns } from './ads-serving';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { AdEventTypeName } from './dto/ads-events.dto';

/**
 * Task ADS-05. Records a view, tap or skip of a sponsored card.
 *
 * What counts: the campaign is one GET /ads could serve THIS viewer at the
 * server's clock now, by the very same function (servableCampaigns in
 * ads-serving.ts: all five rules, including that the card's event is open and
 * its host is not blocked either way with the viewer). It need not be the
 * heaviest booking for its placement: a heavier one may have been booked since
 * the card was served. There is no grace: a report that arrives after the
 * event closed, the window ended or the campaign was paused is not counted.
 *
 * One row per (campaign, person, kind, UTC day). The row and the day's total
 * are written by ONE statement, so they cannot disagree, and two requests for
 * the same key at once leave one row and one count (the second waits for the
 * first on the primary key, finds it there and writes nothing).
 */
@Injectable()
export class AdsEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
    @Inject(ADS_CLOCK) private readonly clock: AdsClock,
  ) {}

  /** Counts the event unless this person already has it today. Throws 404 when the campaign is not being served. */
  async record(
    viewerWawuId: string,
    campaignId: string,
    type: AdEventTypeName,
  ): Promise<void> {
    // One reading of the clock decides both the check and the day.
    const now = this.clock();

    const countable = await servableCampaigns(
      { prisma: this.prisma, blocked: this.blocked },
      viewerWawuId,
      now,
      { campaignId },
    );
    if (countable.length === 0) throw new NotFoundException('Ad not found');

    const day = utcDay(now);
    // The instant goes in as text cast to a zone-less timestamp, so the stored
    // value is the UTC reading whatever the connection's time zone is.
    const at = now.toISOString().slice(0, 23);
    await this.prisma.$executeRaw`
      WITH new_event AS (
        INSERT INTO "AdEvent" ("campaignId", "viewerWawuId", "type", "day", "createdAt")
        VALUES (${campaignId}, ${viewerWawuId}, ${type}::"AdEventType", ${day}::date, ${at}::timestamp)
        ON CONFLICT DO NOTHING
        RETURNING "campaignId", "day", "type"
      )
      INSERT INTO "AdDailyTotal" ("campaignId", "day", "views", "taps", "skips")
      SELECT "campaignId", "day",
             (CASE WHEN "type" = 'view' THEN 1 ELSE 0 END),
             (CASE WHEN "type" = 'tap'  THEN 1 ELSE 0 END),
             (CASE WHEN "type" = 'skip' THEN 1 ELSE 0 END)
      FROM new_event
      ON CONFLICT ("campaignId", "day") DO UPDATE SET
        "views" = "AdDailyTotal"."views" + EXCLUDED."views",
        "taps"  = "AdDailyTotal"."taps"  + EXCLUDED."taps",
        "skips" = "AdDailyTotal"."skips" + EXCLUDED."skips"`;
  }
}
