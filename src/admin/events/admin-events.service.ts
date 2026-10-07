import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type {
  EventModel,
  EventSpeakerModel,
} from '../../../generated/prisma/models';
import type {
  AdminEventAction,
  EventStatus,
} from '../../../generated/prisma/enums';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { initialsFor } from '../../event/event-view.type';
import {
  toAdminEventReviewEntryView,
  type AdminEventDecisionView,
  type AdminEventDetailView,
  type AdminEventHostView,
  type AdminEventListItemView,
  type AdminEventQueueItemView,
  type AdminEventReviewDetailView,
  type AdminEventTicketTypeView,
} from './admin-event-view.type';
import type {
  AdminEventListQueryDto,
  AdminEventQueueQueryDto,
} from './dto/admin-event-queue-query.dto';
import type { EventDecisionReasonDto } from './dto/event-decision-reason.dto';

const MS_PER_HOUR = 3_600_000;

type EventWithSpeakers = EventModel & { speakers: EventSpeakerModel[] };

/**
 * What one admin decision changes, expressed as data rather than as six
 * near-identical methods.
 *
 * `from` is BOTH the precondition checked for a readable error message and the
 * guard on the conditional `updateMany` that actually claims the row — see
 * `decide`. Keeping them the same object is what stops the message and the
 * write from drifting apart.
 */
interface Transition {
  action: AdminEventAction;
  /** Statuses this decision may be applied from. */
  from: EventStatus[];
  /** Required value of `featured` before the decision, when the decision is about the pin. */
  fromFeatured?: boolean;
  /** The status afterwards. Omitted when the decision does not move status. */
  toStatus?: EventStatus;
  /** The pin afterwards. Omitted when the decision does not touch the pin. */
  toFeatured?: boolean;
  /** True for the two decisions the host is owed an explanation for. */
  reasonRequired: boolean;
}

/**
 * Events — the admin half. Reinstated 22 Aug 2026 by product-owner decision.
 *
 * Modelled directly on AdminContentReviewService: user submits → row is
 * `pending` → an admin queue approves or rejects with a reason → the decision
 * is written to a side table with the admin's identity snapshotted. That is
 * this codebase's existing answer to exactly this problem and inventing a
 * second moderation idiom would make both harder to reason about.
 *
 * ── EVERY STATE HAS AN EXIT ──────────────────────────────────────────────────
 * A `pending` row that no endpoint can move is the worst bug this backend has
 * shipped (see AdminContentReviewService's header: every ContentPiece ever
 * uploaded was invisible to every buyer, forever, because nothing wrote
 * `live`). The Event lifecycle is closed on purpose:
 *
 *   pending   → published   approve
 *   pending   → rejected    reject   (reason required)
 *   rejected  → pending     the host edits and resubmits (EventService.update)
 *   published → pending     the host edits (EventService.update)
 *   published → removed     remove   (reason required; clears the pin)
 *   removed   → published   restore
 *
 * ── NO MONEY ─────────────────────────────────────────────────────────────────
 * Nothing in this service reads or writes a price, an amount, a Purchase, a
 * CreditSpend or an earnings figure, and nothing may be added that does. The
 * spec cut event TICKETS; "going" is an interest signal. `goingCount` below is
 * a count of people, and a takedown does not refund anybody because nobody paid
 * anything.
 */
@Injectable()
export class AdminEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /admin/events/queue — everything waiting on a human, oldest first.
   *
   * `pending` only. A queue that also listed published and rejected events
   * would make "how far behind are we" unanswerable, which is the one question
   * it exists to answer. The all-statuses browse is `list` below.
   */
  async queue(
    query: AdminEventQueueQueryDto,
  ): Promise<Paginated<AdminEventQueueItemView>> {
    const where = { status: 'pending' as const };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        include: { speakers: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: query.sort === 'newest' ? 'desc' : 'asc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.event.count({ where }),
    ]);
    // R-42 (F2): the reviewer sees the prices they are approving.
    const [items, tiers] = await Promise.all([
      this.toListItems(rows),
      this.ticketTypesOf(rows.map((r) => r.id)),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        ticketTypes: tiers.get(item.id) ?? [],
      })),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /**
   * GET /admin/events — every event at every status, `?status=` to narrow.
   *
   * Not a convenience. Feature, unfeature and takedown all act on PUBLISHED
   * events, which are never in the pending queue; without this endpoint those
   * three controls would exist with nothing reachable to use them on.
   */
  async list(
    query: AdminEventListQueryDto,
  ): Promise<Paginated<AdminEventListItemView>> {
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        include: { speakers: { orderBy: { order: 'asc' } } },
        orderBy: { startsAt: query.sort === 'latest' ? 'desc' : 'asc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.event.count({ where }),
    ]);
    return {
      items: await this.toListItems(rows),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /** GET /admin/events/:id — any status, plus every decision ever made on it. */
  async detail(id: string): Promise<AdminEventReviewDetailView> {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: { speakers: { orderBy: { order: 'asc' } } },
    });
    if (!event) throw new NotFoundException('Event not found.');
    // R-42 (F2): and the event's ticket types, so the prices are reviewed
    // with the event.
    const [detail, tiers] = await Promise.all([
      this.toDetail(event),
      this.ticketTypesOf([event.id]),
    ]);
    return { ...detail, ticketTypes: tiers.get(event.id) ?? [] };
  }

  /** pending → published. From here the event is on every public read path. */
  async approve(
    id: string,
    admin: AdminUserView,
  ): Promise<AdminEventDecisionView> {
    return this.decide(id, admin, null, {
      action: 'approved',
      from: ['pending'],
      toStatus: 'published',
      reasonRequired: false,
    });
  }

  /** pending → rejected, reason required. The host reads it on GET /events/mine. */
  async reject(
    id: string,
    dto: EventDecisionReasonDto,
    admin: AdminUserView,
  ): Promise<AdminEventDecisionView> {
    return this.decide(id, admin, dto.reason.trim(), {
      action: 'rejected',
      from: ['pending'],
      toStatus: 'rejected',
      reasonRequired: true,
    });
  }

  /**
   * Pin to the featured rail. Published only — pinning something the public
   * cannot open is a rail that leads to a 404.
   */
  async feature(
    id: string,
    admin: AdminUserView,
  ): Promise<AdminEventDecisionView> {
    return this.decide(id, admin, null, {
      action: 'featured',
      from: ['published'],
      fromFeatured: false,
      toFeatured: true,
      reasonRequired: false,
    });
  }

  /**
   * Unpin. Allowed from ANY status, unlike `feature`: a pinned event that its
   * host has since edited is back at `pending`, and an admin must still be
   * able to take the pin off it. Restricting this to `published` would strand
   * the pin on a row nobody could reach.
   */
  async unfeature(
    id: string,
    admin: AdminUserView,
  ): Promise<AdminEventDecisionView> {
    return this.decide(id, admin, null, {
      action: 'unfeatured',
      from: ['pending', 'published', 'rejected', 'removed'],
      fromFeatured: true,
      toFeatured: false,
      reasonRequired: false,
    });
  }

  /**
   * Take a published event down, reason required.
   *
   * Clears the pin in the same write. A featured-but-removed event is a rail
   * pointing at nothing, and leaving `featured` true would mean the pin came
   * back by itself the moment anyone restored the event.
   *
   * `removed` is not `rejected`: rejected is "this was never published", and
   * its exit is the host editing and resubmitting. Removed is "this WAS
   * published and an admin pulled it", and the host cannot edit out of it —
   * otherwise a takedown would be advisory. Its exit is `restore`.
   *
   * Nothing is refunded because nothing was ever charged. The going signals
   * are left in place: they record who was interested, and deleting them would
   * destroy the only evidence of what the takedown affected.
   */
  async remove(
    id: string,
    dto: EventDecisionReasonDto,
    admin: AdminUserView,
  ): Promise<AdminEventDecisionView> {
    return this.decide(id, admin, dto.reason.trim(), {
      action: 'removed',
      from: ['published'],
      toStatus: 'removed',
      toFeatured: false,
      reasonRequired: true,
    });
  }

  /** removed → published. The exit that stops a takedown being a one-way door. */
  async restore(
    id: string,
    admin: AdminUserView,
  ): Promise<AdminEventDecisionView> {
    return this.decide(id, admin, null, {
      action: 'restored',
      from: ['removed'],
      toStatus: 'published',
      reasonRequired: false,
    });
  }

  // ── the one write path ────────────────────────────────────────────────────

  /**
   * Every admin decision goes through here, so there is exactly one place that
   * claims a row, writes an audit entry, and decides what "already decided"
   * means.
   *
   * The claim is a CONDITIONAL `updateMany` on the precondition, not an
   * unconditional `update`: two admins acting on the same event at the same
   * instant both read the same status above, and an unconditional write would
   * let both through — two audit rows for one decision, and on a
   * feature/unfeature pair, a pin whose final state depends on which write
   * landed second.
   */
  private async decide(
    id: string,
    admin: AdminUserView,
    reason: string | null,
    t: Transition,
  ): Promise<AdminEventDecisionView> {
    const existing = await this.prisma.event.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event not found.');

    if (!t.from.includes(existing.status)) {
      throw new BadRequestException(
        `An event can only be ${t.action} from ${t.from.join(' or ')} — this one is ${existing.status}.`,
      );
    }
    if (t.fromFeatured !== undefined && existing.featured !== t.fromFeatured) {
      throw new BadRequestException(
        existing.featured
          ? 'This event is already featured.'
          : 'This event is not featured.',
      );
    }

    const newStatus = t.toStatus ?? existing.status;
    const newFeatured = t.toFeatured ?? existing.featured;

    const { event, review } = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.event.updateMany({
        where: {
          id,
          status: { in: t.from },
          ...(t.fromFeatured === undefined ? {} : { featured: t.fromFeatured }),
        },
        data: {
          status: newStatus,
          featured: newFeatured,
          // Denormalised so GET /events/mine can show the host WHY without
          // reading an admin table. AdminEventReview stays authoritative;
          // this is the copy the host is allowed to see. Cleared on the
          // decisions that are not an explanation, so a stale rejection note
          // never rides along on a since-approved event.
          lastDecisionReason: t.reasonRequired ? reason : null,
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException(
          'This event was decided by someone else a moment ago.',
        );
      }

      const reviewRow = await tx.adminEventReview.create({
        data: {
          eventId: id,
          hostWawuId: existing.hostWawuId,
          action: t.action,
          previousStatus: existing.status,
          newStatus,
          previousFeatured: existing.featured,
          newFeatured,
          reason,
          // Email and role are SNAPSHOTS, not joins: "who took this event
          // down" has to stay answerable after that admin is renamed or
          // deleted.
          reviewedByAdminId: admin.id,
          reviewedByAdminEmail: admin.email,
          reviewedByAdminRole: admin.role,
        },
      });

      const updated = await tx.event.findUniqueOrThrow({
        where: { id },
        include: { speakers: { orderBy: { order: 'asc' } } },
      });
      return { event: updated, review: reviewRow };
    });

    return {
      event: await this.toDetail(event),
      review: toAdminEventReviewEntryView(review),
    };
  }

  // ── views ─────────────────────────────────────────────────────────────────

  /**
   * The ticket types of these events, cheapest first (the public order), in
   * one read. Only the queue and the detail carry them (R-42, F2); the browse
   * list and the decision answers keep the shape they had.
   */
  private async ticketTypesOf(
    eventIds: string[],
  ): Promise<Map<string, AdminEventTicketTypeView[]>> {
    const out = new Map<string, AdminEventTicketTypeView[]>();
    if (eventIds.length === 0) return out;
    // Retired tiers (EVENTS-11 round 5) are not on sale and not reviewed.
    const rows = await this.prisma.eventTicketType.findMany({
      where: { eventId: { in: eventIds }, retiredAt: null },
      orderBy: [{ priceNaira: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        eventId: true,
        tier: true,
        name: true,
        priceNaira: true,
        quantity: true,
        sold: true,
      },
    });
    for (const { eventId, ...tier } of rows) {
      const list = out.get(eventId) ?? [];
      list.push(tier);
      out.set(eventId, list);
    }
    return out;
  }

  private async toDetail(
    event: EventWithSpeakers,
  ): Promise<AdminEventDetailView> {
    const [[item], history] = await Promise.all([
      this.toListItems([event]),
      this.prisma.adminEventReview.findMany({
        where: { eventId: event.id },
        orderBy: { reviewedAt: 'desc' },
      }),
    ]);
    return { ...item, reviewHistory: history.map(toAdminEventReviewEntryView) };
  }

  /**
   * Rows → admin views, with the going counts and the host blocks resolved in
   * two batched queries rather than per row.
   *
   * `goingCount` is counted here exactly as EventService counts it — same
   * table, same predicate, no cached column anywhere — so an admin and a host
   * are never looking at two different numbers for the same event (law 13).
   */
  private async toListItems(
    rows: EventWithSpeakers[],
  ): Promise<AdminEventListItemView[]> {
    if (rows.length === 0) return [];

    const [counts, hosts] = await Promise.all([
      this.prisma.eventGoing.groupBy({
        by: ['eventId'],
        where: { eventId: { in: rows.map((r) => r.id) } },
        _count: { _all: true },
      }),
      this.resolveHosts(rows.map((r) => r.hostWawuId)),
    ]);
    const countByEvent = new Map(counts.map((c) => [c.eventId, c._count._all]));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      hostOrg: row.hostOrg,
      hostOrgBio: row.hostOrgBio,
      format: row.format,
      type: row.type,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      timeLabel: row.timeLabel,
      timezone: row.timezone,
      location: row.location,
      address: row.address,
      externalUrl: row.externalUrl,
      hasRecap: Boolean(row.recapUrl ?? row.recapText),
      recapUrl: row.recapUrl,
      recapText: row.recapText,
      featured: row.featured,
      status: row.status,
      lastDecisionReason: row.lastDecisionReason,
      goingCount: countByEvent.get(row.id) ?? 0,
      speakers: row.speakers.map((s) => ({
        name: s.name,
        title: s.title,
        photoUrl: s.photoUrl,
        initials: initialsFor(s.name),
        order: s.order,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      waitingHours: Math.max(
        0,
        Math.floor((Date.now() - row.createdAt.getTime()) / MS_PER_HOUR),
      ),
      host: hosts.get(row.hostWawuId) ?? {
        wawuUserId: row.hostWawuId,
        handle: null,
        accountType: null,
      },
    }));
  }

  /**
   * Host context for a set of events, in one batched read.
   *
   * Read-only, and only from the row the app itself reads. A host with no
   * UserProfile is not an error and is not hidden — the event still has to be
   * reviewed — so every field comes back null rather than as a plausible
   * default, and the dashboard shows "unknown" instead of inventing one.
   */
  private async resolveHosts(
    wawuUserIds: string[],
  ): Promise<Map<string, AdminEventHostView>> {
    const ids = [...new Set(wawuUserIds)];
    if (ids.length === 0) return new Map();

    const profiles = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: ids } },
    });
    const byId = new Map(profiles.map((p) => [p.wawuUserId, p]));

    return new Map(
      ids.map((wawuUserId) => {
        const profile = byId.get(wawuUserId);
        return [
          wawuUserId,
          {
            wawuUserId,
            handle: profile?.handle ?? null,
            accountType: profile?.accountType ?? null,
          },
        ];
      }),
    );
  }
}
