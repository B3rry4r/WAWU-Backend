import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  AdCampaignModel,
  AdCreativeModel,
  EventModel,
} from '../../../generated/prisma/models';
import {
  AdCampaignStatus,
  AdPlacement,
  type AdminAdAction,
} from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdsCountsService } from '../../ads/ads-counts.service';
import type { AdCounts, AdDayRange } from '../../ads/ads-counts.type';
import { utcDay } from '../../ads/ads-day';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { AdminUserView } from '../auth/admin-user-view.type';
import {
  ACTION_FROM,
  DELETABLE_STATUSES,
  EDITABLE_STATUSES,
  SERVED_STATUSES,
  onAirStatus,
  phaseOf,
  type AdAction,
  type AdPhase,
} from './ad-campaign-state';
import { parseUtcInstant } from './ad-text';
import {
  toAdAuditEntryView,
  type AdAuditEntryView,
  type AdCampaignChangeView,
  type AdCampaignDeletedView,
  type AdCampaignDetailView,
  type AdCampaignReportView,
  type AdCampaignView,
  type AdEventView,
  type AdOverlapView,
  type AdSummaryReportView,
} from './admin-ad-view.type';
import type {
  AdCampaignFilterDto,
  AdCampaignListQueryDto,
  AdReportRangeDto,
  CreateAdCampaignDto,
  UpdateAdCampaignDto,
} from './dto/admin-ad.dto';

type CampaignRow = AdCampaignModel & { creative: AdCreativeModel | null };
type Tx = Prisma.TransactionClient;
/** What the read helpers need: the client or a transaction. */
type Db = Pick<Tx, 'adCampaign' | 'adminAdAudit' | 'event'>;
type EventRow = Pick<
  EventModel,
  'id' | 'name' | 'status' | 'startsAt' | 'endsAt' | 'cancelledAt'
>;

const MS_PER_MINUTE = 60_000;

/**
 * A change waits for the campaign's lock behind any change already running, so
 * the transaction is given longer than Prisma's default 2 s to start and 5 s to
 * finish. A change that holds the lock is a handful of statements.
 */
const LOCK_WAIT = { maxWait: 10_000, timeout: 15_000 } as const;

/** Everything an admin can set, flat, for the audit trail's before and after. */
type Snapshot = Record<string, string | number | null>;

const ACTION_NAME: Record<AdAction, AdminAdAction> = {
  schedule: 'scheduled',
  pause: 'paused',
  resume: 'resumed',
  end: 'ended',
};

function conflict(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ConflictException {
  return new ConflictException({ message, reason: { code, ...extra } });
}

function refuse(code: string, message: string): BadRequestException {
  return new BadRequestException({ message, reason: { code } });
}

function snapshotOf(
  campaign: AdCampaignModel,
  creative: AdCreativeModel,
): Snapshot {
  return {
    advertiser: campaign.advertiser,
    placement: campaign.placement,
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt.toISOString(),
    weight: campaign.weight,
    headline: creative.headline,
    subline: creative.subline,
    ctaLabel: creative.ctaLabel,
    ctaDestination: creative.ctaDestination,
    ctaDestinationId: creative.ctaDestinationId,
    artworkUrl: creative.artworkUrl,
  };
}

/** `{ field: { from, to } }` for every field that differs. `null` on a side means "no row". */
function diff(
  before: Snapshot | null,
  after: Snapshot | null,
): Record<string, { from: unknown; to: unknown }> {
  const keys = Object.keys((after ?? before) as Snapshot);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = before ? before[key] : null;
    const to = after ? after[key] : null;
    if (from !== to) out[key] = { from, to };
  }
  return out;
}

/** Published, not called off, not over: the test serving (ADS-04) puts on the card's event. */
function isOpen(event: EventRow, now: Date): boolean {
  if (event.status !== 'published' || event.cancelledAt !== null) return false;
  const end = event.endsAt ?? event.startsAt;
  return end.getTime() >= now.getTime();
}

/**
 * The admin half of sponsored cards (ADS-06, R-15): ads are booked by the WAWU
 * team, so these routes create, edit, schedule, pause, resume, end and report
 * on campaigns. Nothing here takes money.
 *
 * ── ONE WRITE PATH ───────────────────────────────────────────────────────────
 * Every change runs in one transaction that first locks the campaign row
 * (`SELECT ... FOR UPDATE`), re-reads it, checks the transition, claims it with
 * a conditional `updateMany` (where status is the status just read) and writes
 * the audit row. Two requests for one campaign take the lock in turn, so the
 * second sees what the first did: one outcome, one audit row, and a clear 409
 * for the loser.
 *
 * ── WHEN A PAUSE TAKES EFFECT ────────────────────────────────────────────────
 * ADS-04 reads `status` on every request and sets `Cache-Control: no-store`,
 * so a pause is in force from the moment this transaction commits, which is
 * before the response is sent. "Within a minute" is met with nothing to wait
 * for.
 *
 * ── NO TIMER ─────────────────────────────────────────────────────────────────
 * Nothing moves a campaign to `live` or `ended` when its window opens or
 * closes; serving checks the window itself. See ad-campaign-state.ts.
 *
 * Nothing in this file logs a campaign's fields: the advertiser may be a named
 * person.
 */
@Injectable()
export class AdminAdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly counts: AdsCountsService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  /** GET /admin/ads: filtered, in a fixed order, in offset pages. */
  async list(
    query: AdCampaignListQueryDto,
  ): Promise<Paginated<AdCampaignView>> {
    const now = new Date();
    const where = this.filterWhere(query, now);
    const dir = query.sort === 'soonest' ? 'asc' : 'desc';
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.adCampaign.findMany({
        where,
        include: { creative: true },
        orderBy: [{ startsAt: dir }, { id: dir }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.adCampaign.count({ where }),
    ]);
    const items = await this.toViews(
      this.prisma,
      rows,
      now,
      this.dayRange(this.range(query)),
    );
    return {
      items,
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /** GET /admin/ads/:id: one campaign, its overlaps and everything done to it. */
  async detail(id: string): Promise<AdCampaignDetailView> {
    return this.detailOf(this.prisma, id);
  }

  /** GET /admin/ads/:id/report. */
  async report(
    id: string,
    query: AdReportRangeDto = {},
  ): Promise<AdCampaignReportView> {
    const now = new Date();
    const range = this.range(query);
    const days = this.dayRange(range);
    const row = await this.prisma.adCampaign.findUnique({
      where: { id },
      include: { creative: true },
    });
    if (!row) throw new NotFoundException('Campaign not found.');
    const [[campaign], history, counted] = await Promise.all([
      this.toViews(this.prisma, [row], now, days),
      this.prisma.adminAdAudit.findMany({
        where: { campaignId: id },
        orderBy: { seq: 'desc' },
        select: { action: true, createdAt: true },
      }),
      this.counts.forCampaign(id, days),
    ]);
    const window = row.endsAt.getTime() - row.startsAt.getTime();
    const elapsed = Math.min(
      window,
      Math.max(0, now.getTime() - row.startsAt.getTime()),
    );
    const windowMinutes = Math.floor(window / MS_PER_MINUTE);
    const elapsedMinutes = Math.floor(elapsed / MS_PER_MINUTE);
    return {
      campaign,
      range: {
        from: range.from ?? null,
        to: range.to ?? null,
        fromDay: days.from ?? null,
        toDay: days.to ?? null,
      },
      delivery: counted.delivery,
      days: counted.days,
      timing: {
        windowMinutes,
        elapsedMinutes,
        remainingMinutes: windowMinutes - elapsedMinutes,
      },
      activity: {
        changes: history.length,
        pauses: history.filter((h) => h.action === 'paused').length,
        lastActionAt: history[0]?.createdAt ?? null,
      },
    };
  }

  /** GET /admin/ads/report: the bookings in a range, counted. */
  async summary(query: AdCampaignFilterDto): Promise<AdSummaryReportView> {
    const now = new Date();
    const where = this.filterWhere(query, now);
    const phases: AdPhase[] = ['upcoming', 'running', 'over'];

    const statuses = Object.values(AdCampaignStatus);
    const placements = Object.values(AdPlacement);
    const [campaigns, ...counts] = await this.prisma.$transaction([
      this.prisma.adCampaign.count({ where }),
      ...statuses.map((status) =>
        this.prisma.adCampaign.count({ where: { AND: [where, { status }] } }),
      ),
      ...placements.map((placement) =>
        this.prisma.adCampaign.count({
          where: { AND: [where, { placement }] },
        }),
      ),
      ...phases.map((p) =>
        this.prisma.adCampaign.count({
          where: { AND: [where, this.phaseWhere(p, now)] },
        }),
      ),
    ]);
    const byStatus = counts.slice(0, statuses.length);
    const byPlacement = counts.slice(
      statuses.length,
      statuses.length + placements.length,
    );
    const phaseCounts = counts.slice(statuses.length + placements.length);

    const servable = await this.prisma.adCampaign.findMany({
      where: {
        status: { in: [...SERVED_STATUSES] },
        startsAt: { lte: now },
        endsAt: { gt: now },
        creative: { isNot: null },
      },
      include: { creative: true },
    });
    const servableViews = await this.toViews(this.prisma, servable, now, {});

    const days = this.dayRange(this.range(query));
    const matching = await this.prisma.adCampaign.findMany({
      where,
      select: { id: true, status: true, placement: true },
    });
    const ids = matching.map((m) => m.id);
    const [overall, perCampaign] = await Promise.all([
      this.counts.summary(days, ids),
      this.counts.totalsFor(ids, days),
    ]);
    const byStatusDelivery = this.groupDelivery(
      statuses,
      matching,
      (m) => m.status,
      perCampaign,
    );
    const byPlacementDelivery = this.groupDelivery(
      placements,
      matching,
      (m) => m.placement,
      perCampaign,
    );

    return {
      generatedAt: now,
      filters: {
        placement: query.placement ?? null,
        status: query.status ?? null,
        phase: query.phase ?? null,
        from: query.from ? new Date(query.from) : null,
        to: query.to ? new Date(query.to) : null,
      },
      campaigns,
      delivery: overall,
      deliveryByStatus: byStatusDelivery,
      deliveryByPlacement: byPlacementDelivery,
      byStatus: Object.fromEntries(
        statuses.map((st, i) => [st, byStatus[i]]),
      ) as AdSummaryReportView['byStatus'],
      byPlacement: Object.fromEntries(
        placements.map((pl, i) => [pl, byPlacement[i]]),
      ) as AdSummaryReportView['byPlacement'],
      byPhase: Object.fromEntries(
        phases.map((p, i) => [p, phaseCounts[i]]),
      ) as AdSummaryReportView['byPhase'],
      servingNow: Object.fromEntries(
        placements.map((p) => [
          p,
          servableViews.filter((v) => v.placement === p && v.servingNow).length,
        ]),
      ) as AdSummaryReportView['servingNow'],
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** POST /admin/ads: a draft. Nothing is served until it is scheduled. */
  async create(
    dto: CreateAdCampaignDto,
    admin: AdminUserView,
  ): Promise<AdCampaignChangeView> {
    const now = new Date();
    const startsAt = this.instant(dto.startsAt, 'startsAt');
    const endsAt = this.instant(dto.endsAt, 'endsAt');
    this.assertWindow(startsAt, endsAt, now);
    await this.assertEventOpen(
      this.prisma,
      dto.creative.ctaDestination,
      dto.creative.ctaDestinationId,
      now,
      'bad_input',
    );

    const audit = await this.prisma.$transaction(async (tx) => {
      const created = await tx.adCampaign.create({
        data: {
          advertiser: dto.advertiser,
          placement: dto.placement,
          status: 'draft',
          startsAt,
          endsAt,
          ...(dto.weight === undefined ? {} : { weight: dto.weight }),
          creative: {
            create: {
              headline: dto.creative.headline,
              subline: dto.creative.subline ?? null,
              ctaLabel: dto.creative.ctaLabel,
              ctaDestination: dto.creative.ctaDestination,
              ctaDestinationId: dto.creative.ctaDestinationId,
              artworkUrl: dto.creative.artworkUrl ?? null,
            },
          },
        },
        include: { creative: true },
      });
      const creative = created.creative as AdCreativeModel;
      return {
        id: created.id,
        entry: await this.writeAudit(tx, admin, {
          campaignId: created.id,
          action: 'created',
          previousStatus: null,
          newStatus: 'draft',
          changes: diff(null, snapshotOf(created, creative)),
        }),
      };
    });
    return {
      campaign: await this.detailOf(this.prisma, audit.id),
      audit: toAdAuditEntryView(audit.entry),
    };
  }

  /** PATCH /admin/ads/:id: only a draft or a paused campaign. */
  async update(
    id: string,
    dto: UpdateAdCampaignDto,
    admin: AdminUserView,
  ): Promise<AdCampaignChangeView> {
    const entry = await this.withLockedCampaign(id, async (tx, row) => {
      if (!EDITABLE_STATUSES.includes(row.status)) {
        throw conflict(
          'not_editable',
          `A campaign can only be edited while it is ${EDITABLE_STATUSES.join(' or ')}. This one is ${row.status}. Pause it first.`,
          { status: row.status, allowedFrom: EDITABLE_STATUSES },
        );
      }
      const creative = row.creative;
      if (!creative) {
        throw conflict('no_creative', 'This campaign has no card.');
      }

      const now = new Date();
      const startsAt = dto.startsAt
        ? this.instant(dto.startsAt, 'startsAt')
        : row.startsAt;
      const endsAt = dto.endsAt
        ? this.instant(dto.endsAt, 'endsAt')
        : row.endsAt;
      const c = dto.creative ?? {};

      const before = snapshotOf(row, creative);
      const nextCampaign: AdCampaignModel = {
        ...row,
        advertiser: dto.advertiser ?? row.advertiser,
        placement: dto.placement ?? row.placement,
        startsAt,
        endsAt,
        weight: dto.weight ?? row.weight,
      };
      const nextCreative: AdCreativeModel = {
        ...creative,
        headline: c.headline ?? creative.headline,
        subline: c.subline === undefined ? creative.subline : c.subline,
        ctaLabel: c.ctaLabel ?? creative.ctaLabel,
        ctaDestination: c.ctaDestination ?? creative.ctaDestination,
        ctaDestinationId: c.ctaDestinationId ?? creative.ctaDestinationId,
        artworkUrl:
          c.artworkUrl === undefined ? creative.artworkUrl : c.artworkUrl,
      };
      const after = snapshotOf(nextCampaign, nextCreative);
      const changes = diff(before, after);
      if (Object.keys(changes).length === 0) {
        throw refuse(
          'no_change',
          'Nothing to change: every value is the same.',
        );
      }

      if (changes.startsAt || changes.endsAt) {
        this.assertWindow(startsAt, endsAt, now);
      }
      if (changes.ctaDestination || changes.ctaDestinationId) {
        await this.assertEventOpen(
          tx,
          nextCreative.ctaDestination,
          nextCreative.ctaDestinationId,
          now,
          'bad_input',
        );
      }

      const claimed = await tx.adCampaign.updateMany({
        where: { id, status: row.status },
        data: {
          advertiser: nextCampaign.advertiser,
          placement: nextCampaign.placement,
          startsAt,
          endsAt,
          weight: nextCampaign.weight,
          updatedAt: now,
        },
      });
      if (claimed.count !== 1) throw this.changedUnderneath();
      await tx.adCreative.update({
        where: { campaignId: id },
        data: {
          headline: nextCreative.headline,
          subline: nextCreative.subline,
          ctaLabel: nextCreative.ctaLabel,
          ctaDestination: nextCreative.ctaDestination,
          ctaDestinationId: nextCreative.ctaDestinationId,
          artworkUrl: nextCreative.artworkUrl,
        },
      });
      return this.writeAudit(tx, admin, {
        campaignId: id,
        action: 'updated',
        previousStatus: row.status,
        newStatus: row.status,
        changes,
      });
    });
    return {
      campaign: await this.detailOf(this.prisma, id),
      audit: toAdAuditEntryView(entry),
    };
  }

  /** POST /admin/ads/:id/schedule: draft to scheduled, or to live if its window has started. */
  schedule(id: string, admin: AdminUserView): Promise<AdCampaignChangeView> {
    return this.transition(id, 'schedule', admin);
  }

  /** POST /admin/ads/:id/pause: scheduled or live to paused. Serving stops at once. */
  pause(id: string, admin: AdminUserView): Promise<AdCampaignChangeView> {
    return this.transition(id, 'pause', admin);
  }

  /** POST /admin/ads/:id/resume: paused back on air. */
  resume(id: string, admin: AdminUserView): Promise<AdCampaignChangeView> {
    return this.transition(id, 'resume', admin);
  }

  /** POST /admin/ads/:id/end: end early. Final. */
  end(id: string, admin: AdminUserView): Promise<AdCampaignChangeView> {
    return this.transition(id, 'end', admin);
  }

  /** DELETE /admin/ads/:id: a draft only. Its history stays. */
  async remove(
    id: string,
    admin: AdminUserView,
  ): Promise<AdCampaignDeletedView> {
    const entry = await this.withLockedCampaign(id, async (tx, row) => {
      if (!DELETABLE_STATUSES.includes(row.status)) {
        throw conflict(
          'not_deletable',
          `Only a draft can be deleted. This campaign is ${row.status}; end it instead.`,
          { status: row.status, allowedFrom: DELETABLE_STATUSES },
        );
      }
      const removed = await tx.adCampaign.deleteMany({
        where: { id, status: row.status },
      });
      if (removed.count !== 1) throw this.changedUnderneath();
      return this.writeAudit(tx, admin, {
        campaignId: id,
        action: 'deleted',
        previousStatus: row.status,
        newStatus: null,
        changes: row.creative
          ? diff(snapshotOf(row, row.creative), null)
          : null,
      });
    });
    return { campaignId: id, audit: toAdAuditEntryView(entry) };
  }

  // ── the one transition path ───────────────────────────────────────────────

  private async transition(
    id: string,
    action: AdAction,
    admin: AdminUserView,
  ): Promise<AdCampaignChangeView> {
    const entry = await this.withLockedCampaign(id, async (tx, row) => {
      const allowed = ACTION_FROM[action];
      if (!allowed.includes(row.status)) {
        throw conflict(
          'invalid_transition',
          `A campaign can only be ${ACTION_NAME[action]} from ${allowed.join(' or ')}. This one is ${row.status}.`,
          { action, status: row.status, allowedFrom: allowed },
        );
      }

      const now = new Date();
      let to: AdCampaignStatus;
      if (action === 'pause') {
        to = 'paused';
      } else if (action === 'end') {
        to = 'ended';
      } else {
        // schedule and resume put the card on air: it must have a card, a
        // window that has not closed and an event that can still be opened.
        if (!row.creative) {
          throw conflict('no_creative', 'This campaign has no card.');
        }
        if (row.endsAt.getTime() <= now.getTime()) {
          throw conflict(
            'window_over',
            'The window of this campaign has already closed. Edit the dates first.',
            { endsAt: row.endsAt },
          );
        }
        await this.assertEventOpen(
          tx,
          row.creative.ctaDestination,
          row.creative.ctaDestinationId,
          now,
          'conflict',
        );
        to = onAirStatus(row.startsAt, now);
      }

      const claimed = await tx.adCampaign.updateMany({
        where: { id, status: row.status },
        data: { status: to },
      });
      if (claimed.count !== 1) throw this.changedUnderneath();
      return this.writeAudit(tx, admin, {
        campaignId: id,
        action: ACTION_NAME[action],
        previousStatus: row.status,
        newStatus: to,
        changes: { status: { from: row.status, to } },
      });
    });
    return {
      campaign: await this.detailOf(this.prisma, id),
      audit: toAdAuditEntryView(entry),
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Runs `fn` in a transaction that holds the campaign row's lock and has read
   * the row after taking it. 404 when there is no such campaign.
   */
  private withLockedCampaign<T>(
    id: string,
    fn: (tx: Tx, row: CampaignRow) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "AdCampaign" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0)
        throw new NotFoundException('Campaign not found.');
      const row = await tx.adCampaign.findUniqueOrThrow({
        where: { id },
        include: { creative: true },
      });
      return fn(tx, row);
    }, LOCK_WAIT);
  }

  private changedUnderneath(): ConflictException {
    return conflict(
      'changed',
      'This campaign was changed by someone else a moment ago. Reload it and try again.',
    );
  }

  private writeAudit(
    tx: Tx,
    admin: AdminUserView,
    entry: {
      campaignId: string;
      action: AdminAdAction;
      previousStatus: AdCampaignStatus | null;
      newStatus: AdCampaignStatus | null;
      changes: Record<string, unknown> | null;
    },
  ) {
    return tx.adminAdAudit.create({
      data: {
        campaignId: entry.campaignId,
        action: entry.action,
        previousStatus: entry.previousStatus,
        newStatus: entry.newStatus,
        changes:
          entry.changes === null
            ? Prisma.DbNull
            : (entry.changes as Prisma.InputJsonValue),
        // Email and role are snapshots, as in AdminEventReview: "who paused
        // this" stays answerable after that admin is renamed or removed.
        adminId: admin.id,
        adminEmail: admin.email,
        adminRole: admin.role,
      },
    });
  }

  private instant(raw: string, field: string): Date {
    const date = parseUtcInstant(raw);
    if (!date) throw refuse('bad_time', `${field} must be a UTC time.`);
    return date;
  }

  /** The window must run forward and must not already be over. */
  private assertWindow(startsAt: Date, endsAt: Date, now: Date): void {
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw refuse('bad_window', 'endsAt must be after startsAt.');
    }
    if (endsAt.getTime() <= now.getTime()) {
      throw refuse('bad_window', 'endsAt must be in the future.');
    }
  }

  /**
   * The card's button opens an Event: it must exist, be published, not be
   * called off and not be over (the test serving applies). Checked when a
   * campaign is created, when its event is changed, when it is scheduled and
   * when it is resumed. If the event closes after that, the campaign is left alone
   * and serving skips it (ADS-04); the admin views show `event.open: false`.
   *
   * A bad event named in a create or edit body is a 400 (the input is wrong);
   * a campaign that cannot go on air because its event closed is a 409 (the
   * request was right and the world moved).
   */
  private async assertEventOpen(
    db: Pick<Tx, 'event'>,
    destination: string,
    eventId: string,
    now: Date,
    kind: 'bad_input' | 'conflict',
  ): Promise<void> {
    if (destination !== 'event') {
      throw refuse('bad_destination', 'ctaDestination is not one we can open.');
    }
    const event = await db.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        status: true,
        startsAt: true,
        endsAt: true,
        cancelledAt: true,
      },
    });
    if (event && isOpen(event, now)) return;
    const message = !event
      ? 'That event does not exist.'
      : 'That event is not open: it must be published, not called off and not over.';
    throw kind === 'bad_input'
      ? refuse('event_not_open', message)
      : conflict('event_not_open', message, { eventId });
  }

  /**
   * The instants a request asked for, as given. `from` and `to` are UTC
   * instants, `to` exclusive, as for the window filter.
   */
  private range(f: { from?: string; to?: string }): {
    from?: Date;
    to?: Date;
  } {
    const from = f.from ? this.instant(f.from, 'from') : undefined;
    const to = f.to ? this.instant(f.to, 'to') : undefined;
    if (from && to && to.getTime() <= from.getTime()) {
      throw refuse('bad_range', 'to must be after from.');
    }
    return { from, to };
  }

  /**
   * Counts are kept by UTC day (ADS-05), so an instant range becomes the UTC
   * days that have any part inside [from, to): from the day of `from` to the
   * day of the last millisecond before `to`, both ends inclusive. A range that
   * starts at 09:00 counts that whole day; a `to` at exactly midnight leaves
   * that midnight's day out. The last day is never earlier than 0001-01-01,
   * the first day the database holds (nothing is counted before it).
   */
  private dayRange(r: { from?: Date; to?: Date }): AdDayRange {
    const out: AdDayRange = {};
    if (r.from) out.from = utcDay(r.from);
    if (r.to) {
      const last = utcDay(new Date(r.to.getTime() - 1));
      out.to = last < '0001-01-01' ? '0001-01-01' : last;
    }
    return out;
  }

  /** Counts summed per key (status or placement), every key present. */
  private groupDelivery<K extends string, T extends { id: string }>(
    keys: K[],
    rows: T[],
    keyOf: (row: T) => K,
    perCampaign: Record<string, AdCounts>,
  ): Record<K, AdCounts> {
    const sums = Object.fromEntries(
      keys.map((k) => [k, { views: 0, taps: 0, skips: 0 }]),
    ) as Record<K, { views: number; taps: number; skips: number }>;
    for (const row of rows) {
      const c = perCampaign[row.id];
      const t = sums[keyOf(row)];
      t.views += c.views;
      t.taps += c.taps;
      t.skips += c.skips;
    }
    return Object.fromEntries(
      keys.map((k) => [
        k,
        {
          ...sums[k],
          ctr: sums[k].views === 0 ? null : sums[k].taps / sums[k].views,
        },
      ]),
    ) as Record<K, AdCounts>;
  }

  private filterWhere(
    f: AdCampaignFilterDto,
    now: Date,
  ): Prisma.AdCampaignWhereInput {
    const { from, to } = this.range(f);
    const and: Prisma.AdCampaignWhereInput[] = [];
    if (f.status) and.push({ status: f.status });
    if (f.placement) and.push({ placement: f.placement });
    if (f.phase) and.push(this.phaseWhere(f.phase, now));
    if (from) and.push({ endsAt: { gt: from } });
    if (to) and.push({ startsAt: { lt: to } });
    return and.length === 0 ? {} : { AND: and };
  }

  private phaseWhere(phase: AdPhase, now: Date): Prisma.AdCampaignWhereInput {
    if (phase === 'upcoming') return { startsAt: { gt: now } };
    if (phase === 'running') {
      return { startsAt: { lte: now }, endsAt: { gt: now } };
    }
    return { endsAt: { lte: now } };
  }

  // ── views ─────────────────────────────────────────────────────────────────

  private async detailOf(db: Db, id: string): Promise<AdCampaignDetailView> {
    const now = new Date();
    const row = await db.adCampaign.findUnique({
      where: { id },
      include: { creative: true },
    });
    if (!row) throw new NotFoundException('Campaign not found.');
    const [[view], overlaps, history] = await Promise.all([
      this.toViews(db, [row], now, {}),
      db.adCampaign.findMany({
        where: {
          id: { not: id },
          placement: row.placement,
          status: { in: ['scheduled', 'live', 'paused'] },
          startsAt: { lt: row.endsAt },
          endsAt: { gt: row.startsAt },
        },
        orderBy: [{ weight: 'desc' }, { startsAt: 'asc' }, { id: 'asc' }],
      }),
      db.adminAdAudit.findMany({
        where: { campaignId: id },
        orderBy: { seq: 'desc' },
      }),
    ]);
    return {
      ...view,
      overlapping: overlaps.map((o): AdOverlapView => ({
        id: o.id,
        advertiser: o.advertiser,
        status: o.status,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        weight: o.weight,
      })),
      history: history.map((h): AdAuditEntryView => toAdAuditEntryView(h)),
    };
  }

  /** Rows to views, with the events the buttons open resolved in one read. */
  private async toViews(
    db: Db,
    rows: CampaignRow[],
    now: Date,
    days: AdDayRange,
  ): Promise<AdCampaignView[]> {
    // One set-based read of every row's counts, whatever the page size.
    const delivery = await this.counts.totalsFor(
      rows.map((r) => r.id),
      days,
    );
    const eventIds = [
      ...new Set(
        rows.flatMap((r) =>
          r.creative?.ctaDestination === 'event'
            ? [r.creative.ctaDestinationId]
            : [],
        ),
      ),
    ];
    const events =
      eventIds.length === 0
        ? []
        : await db.event.findMany({
            where: { id: { in: eventIds } },
            select: {
              id: true,
              name: true,
              status: true,
              startsAt: true,
              endsAt: true,
              cancelledAt: true,
            },
          });
    const byId = new Map(events.map((e) => [e.id, e]));

    return rows.map((row) => {
      const event =
        row.creative?.ctaDestination === 'event'
          ? byId.get(row.creative.ctaDestinationId)
          : undefined;
      const eventView: AdEventView | null = event
        ? {
            id: event.id,
            name: event.name,
            status: event.status,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            open: isOpen(event, now),
          }
        : null;
      const phase = phaseOf(row.startsAt, row.endsAt, now);
      return {
        id: row.id,
        advertiser: row.advertiser,
        placement: row.placement,
        status: row.status,
        phase,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        weight: row.weight,
        creative: row.creative
          ? {
              headline: row.creative.headline,
              subline: row.creative.subline,
              ctaLabel: row.creative.ctaLabel,
              ctaDestination: row.creative.ctaDestination,
              ctaDestinationId: row.creative.ctaDestinationId,
              artworkUrl: row.creative.artworkUrl,
            }
          : null,
        event: eventView,
        delivery: delivery[row.id],
        servingNow:
          SERVED_STATUSES.includes(row.status) &&
          phase === 'running' &&
          row.creative !== null &&
          eventView?.open === true,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }
}
