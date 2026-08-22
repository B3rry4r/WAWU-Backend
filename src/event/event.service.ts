import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type {
  EventModel,
  EventSpeakerModel,
} from '../../generated/prisma/models';
import type { PaginationQueryDto } from '../common/dto/pagination.dto';
import {
  initialsFor,
  type EventGoingView,
  type EventView,
} from './event-view.type';
import type { CreateEventDto, EventSpeakerDto } from './dto/create-event.dto';
import type { UpdateEventDto } from './dto/update-event.dto';
import type { ListEventsQueryDto } from './dto/list-events-query.dto';

type EventWithSpeakers = EventModel & { speakers: EventSpeakerModel[] };

/**
 * Events — the app-facing half. Reinstated 22 Aug 2026 by product-owner
 * decision, reversing the "no Events section" line in WAWU-Web/CLAUDE.md and
 * docs/00_PLATFORM_MAP.md; both documents were amended with that date rather
 * than left contradicting this code.
 *
 * ── NO MONEY, ANYWHERE IN THIS FILE ──────────────────────────────────────────
 * What the spec cut was event TICKETS. This service never reads or writes a
 * price, an amount, a Purchase, a CreditSpend, a CreatorEarnings figure or a
 * Flutterwave reference, and it must not start: "Going" is an interest signal,
 * one row per person, and that is the entire economics of this feature. An
 * organiser who charges for entry does it on their own page behind
 * `externalUrl`. Anything that would put a naira figure on an event is a spec
 * conflict — stop and flag it rather than building it.
 *
 * ── WHAT USERS CAN AND CANNOT DO ─────────────────────────────────────────────
 * Any authenticated WAWU user may submit an event; it is created `pending` and
 * is invisible on every public read until an admin approves it (the same
 * user-submitted → queue → approve/reject shape ContentPiece already has, and
 * deliberately not a second moderation idiom). A host may edit their own event,
 * and every edit returns it to `pending` — one rule with no "material field"
 * carve-outs, because a carve-out is a bypass: submit something benign, get
 * approved, then edit it into whatever you actually wanted.
 *
 * Nothing here writes `featured` or sets `status` to `published`. Those are
 * admin decisions and live in src/admin/events/.
 */
@Injectable()
export class EventService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /events — the public list. `published` only, ever.
   *
   * Note this filters on status rather than on some "isVisible" flag computed
   * elsewhere: there is exactly one definition of "the public can see this
   * event" in this backend, and it is `status: 'published'`.
   */
  async list(
    userWawuId: string,
    query: ListEventsQueryDto,
  ): Promise<Paginated<EventView>> {
    const where = {
      status: 'published' as const,
      ...(query.format ? { format: query.format } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.featured === undefined ? {} : { featured: query.featured }),
      ...timeWindow(query.view),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        include: { speakers: { orderBy: { order: 'asc' } } },
        // Upcoming reads forwards from now, past reads backwards from now —
        // in both directions the row nearest to today comes first, which is
        // the only ordering a calendar screen can use unpaginated.
        orderBy: { startsAt: query.view === 'past' ? 'desc' : 'asc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      items: await this.toViews(rows, userWawuId),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /**
   * GET /events/mine — the host's own events at EVERY status, newest first.
   *
   * This endpoint is why `pending` is not a dead end from the submitter's side:
   * without it a host has no way to see that their event is waiting, or to read
   * the reason it was rejected, and their only recourse is to submit it again.
   */
  async listMine(
    userWawuId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<EventView>> {
    const where = { hostWawuId: userWawuId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        include: { speakers: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      items: await this.toViews(rows, userWawuId),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /**
   * GET /events/:id — published to anyone, anything else to its host alone.
   *
   * A non-published event a stranger asks for is a 404 and not a 403: a 403
   * confirms the id exists, which turns this endpoint into an oracle for
   * "which submissions are in the queue".
   */
  async findOne(id: string, userWawuId: string): Promise<EventView> {
    const event = await this.loadVisible(id, userWawuId);
    return (await this.toViews([event], userWawuId))[0];
  }

  /** POST /events — created `pending`, always. There is no path here that publishes. */
  async create(userWawuId: string, dto: CreateEventDto): Promise<EventView> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    assertWindowOrdered(startsAt, endsAt);

    const created = await this.prisma.event.create({
      data: {
        hostWawuId: userWawuId,
        name: dto.name.trim(),
        description: dto.description.trim(),
        hostOrg: dto.hostOrg.trim(),
        hostOrgBio: dto.hostOrgBio?.trim() ?? null,
        format: dto.format,
        type: dto.type,
        startsAt,
        endsAt,
        timeLabel: dto.timeLabel?.trim() ?? null,
        timezone: dto.timezone?.trim() ?? null,
        location: dto.location.trim(),
        address: dto.address?.trim() ?? null,
        externalUrl: dto.externalUrl ?? null,
        // status defaults to `pending` in the schema and is deliberately not
        // named here — there is no argument this method could ever take that
        // would make it anything else.
        speakers: { create: speakerRows(dto.speakers) },
      },
      include: { speakers: { orderBy: { order: 'asc' } } },
    });

    return (await this.toViews([created], userWawuId))[0];
  }

  /**
   * PATCH /events/:id — the host's own event, and back into the queue.
   *
   * `removed` is the one status this refuses. A takedown is an admin decision
   * about something already published; letting the host edit their way out of
   * it would make the takedown advisory. Its exit is POST
   * /admin/events/:id/restore, or a fresh submission.
   *
   * `featured` is deliberately NOT cleared by an edit. The pin is an admin's
   * decision and a host's typo fix should not erase it; while the event sits
   * back at `pending` it is invisible to every public read anyway, because
   * those filter on status and never on `featured` alone.
   */
  async update(
    id: string,
    userWawuId: string,
    dto: UpdateEventDto,
  ): Promise<EventView> {
    const existing = await this.prisma.event.findUnique({ where: { id } });
    if (!existing || existing.hostWawuId !== userWawuId) {
      // Same 404-not-403 reasoning as findOne: an event that is not yours is
      // an event you are not told about.
      throw new NotFoundException('Event not found.');
    }
    if (existing.status === 'removed') {
      throw new ForbiddenException(
        'This event was taken down by an admin and cannot be edited. Submit a new one, or contact support.',
      );
    }

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : existing.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : existing.endsAt;
    assertWindowOrdered(startsAt, endsAt);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.speakers) {
        // Wholesale replacement — see UpdateEventDto. Both halves are in the
        // same transaction so an event is never briefly speakerless.
        await tx.eventSpeaker.deleteMany({ where: { eventId: id } });
      }
      return tx.event.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description.trim() }
            : {}),
          ...(dto.hostOrg !== undefined ? { hostOrg: dto.hostOrg.trim() } : {}),
          ...(dto.hostOrgBio !== undefined
            ? { hostOrgBio: dto.hostOrgBio.trim() || null }
            : {}),
          ...(dto.format !== undefined ? { format: dto.format } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.startsAt !== undefined ? { startsAt } : {}),
          ...(dto.endsAt !== undefined ? { endsAt } : {}),
          ...(dto.timeLabel !== undefined
            ? { timeLabel: dto.timeLabel.trim() || null }
            : {}),
          ...(dto.timezone !== undefined
            ? { timezone: dto.timezone.trim() || null }
            : {}),
          ...(dto.location !== undefined
            ? { location: dto.location.trim() }
            : {}),
          ...(dto.address !== undefined
            ? { address: dto.address.trim() || null }
            : {}),
          ...(dto.externalUrl !== undefined
            ? { externalUrl: dto.externalUrl }
            : {}),
          ...(dto.recapUrl !== undefined ? { recapUrl: dto.recapUrl } : {}),
          ...(dto.recapText !== undefined
            ? { recapText: dto.recapText.trim() || null }
            : {}),
          ...(dto.speakers
            ? { speakers: { create: speakerRows(dto.speakers) } }
            : {}),
          // Every edit re-enters review, and the old decision reason goes with
          // it — a rejection note still attached to a resubmission tells the
          // host they were rejected for something they have just fixed.
          status: 'pending',
          lastDecisionReason: null,
        },
        include: { speakers: { orderBy: { order: 'asc' } } },
      });
    });

    return (await this.toViews([updated], userWawuId))[0];
  }

  /**
   * POST /events/:id/going — "I am interested". Idempotent by construction.
   *
   * The unique constraint on (eventId, userWawuId) IS the idempotency, so this
   * is an upsert rather than a toggle. A toggle would be the wrong contract
   * twice over: it is not idempotent (a retried request silently undoes the
   * signal), and a client that cannot tell a retry from a second tap has no
   * way to recover from a dropped response.
   *
   * Not a ticket, not a reservation, not a purchase. Nothing is charged, no
   * capacity is held, and the only state written is "this person exists in
   * this list".
   */
  async markGoing(id: string, userWawuId: string): Promise<EventGoingView> {
    const event = await this.loadVisible(id, userWawuId);
    if (event.status !== 'published') {
      // Reachable only by the host on their own unpublished event — everyone
      // else already got a 404 from loadVisible.
      throw new BadRequestException('This event is not published yet.');
    }

    await this.prisma.eventGoing.upsert({
      where: { eventId_userWawuId: { eventId: id, userWawuId } },
      update: {},
      create: { eventId: id, userWawuId },
    });

    return {
      eventId: id,
      userGoing: true,
      goingCount: await this.countGoing(id),
    };
  }

  /**
   * DELETE /events/:id/going — withdraw it. Idempotent in the same way: a
   * withdrawal from someone who was never going is a 200 describing the true
   * state, not a 404. The client's job is to end up correct, not to have
   * guessed right first.
   */
  async withdrawGoing(id: string, userWawuId: string): Promise<EventGoingView> {
    await this.loadVisible(id, userWawuId);
    await this.prisma.eventGoing.deleteMany({
      where: { eventId: id, userWawuId },
    });
    return {
      eventId: id,
      userGoing: false,
      goingCount: await this.countGoing(id),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Published to anyone; anything else to its host alone. 404 otherwise. */
  private async loadVisible(
    id: string,
    userWawuId: string,
  ): Promise<EventWithSpeakers> {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: { speakers: { orderBy: { order: 'asc' } } },
    });
    if (
      !event ||
      (event.status !== 'published' && event.hostWawuId !== userWawuId)
    ) {
      throw new NotFoundException('Event not found.');
    }
    return event;
  }

  private async countGoing(eventId: string): Promise<number> {
    return this.prisma.eventGoing.count({ where: { eventId } });
  }

  /**
   * Rows → wire views, with the going counts and the caller's own signal
   * resolved in two batched queries rather than per row.
   *
   * `goingCount` is COUNTED, never read from a denormalised column. There is
   * no counter on Event on purpose: a cached count is a second definition of
   * the same fact and it drifts the first time a row is deleted by a cascade.
   */
  private async toViews(
    rows: EventWithSpeakers[],
    userWawuId: string,
  ): Promise<EventView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [counts, mine] = await Promise.all([
      this.prisma.eventGoing.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.eventGoing.findMany({
        where: { eventId: { in: ids }, userWawuId },
        select: { eventId: true },
      }),
    ]);

    const countByEvent = new Map(counts.map((c) => [c.eventId, c._count._all]));
    const goingIds = new Set(mine.map((m) => m.eventId));

    return rows.map((row) => ({
      id: row.id,
      hostWawuId: row.hostWawuId,
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
      goingCount: countByEvent.get(row.id) ?? 0,
      userGoing: goingIds.has(row.id),
      speakers: row.speakers.map((s) => ({
        name: s.name,
        title: s.title,
        initials: initialsFor(s.name),
        order: s.order,
      })),
      createdAt: row.createdAt,
      // Host-only. A moderator's note is written for the person who has to act
      // on it, not for whoever browses the event afterwards.
      lastDecisionReason:
        row.hostWawuId === userWawuId ? row.lastDecisionReason : null,
    }));
  }
}

/**
 * upcoming / past, decided on `endsAt ?? startsAt`.
 *
 * Prisma has no COALESCE in a `where`, so the two cases are spelled out. The
 * pair is exhaustive and disjoint — every row falls in exactly one of them —
 * which is what stops an event from being in neither list on the day it runs.
 */
function timeWindow(view: 'upcoming' | 'past') {
  const now = new Date();
  return view === 'past'
    ? { OR: [{ endsAt: { lt: now } }, { endsAt: null, startsAt: { lt: now } }] }
    : {
        OR: [
          { endsAt: { gte: now } },
          { endsAt: null, startsAt: { gte: now } },
        ],
      };
}

/** An end before its start is a typo, and it would put the event in neither list. */
function assertWindowOrdered(startsAt: Date, endsAt: Date | null): void {
  if (endsAt && endsAt.getTime() < startsAt.getTime()) {
    throw new BadRequestException('endsAt cannot be before startsAt.');
  }
}

/** Speaker rows, ordered by the position they arrived in unless one says otherwise. */
function speakerRows(speakers: EventSpeakerDto[] | undefined) {
  return (speakers ?? []).map((s, i) => ({
    name: s.name.trim(),
    title: s.title?.trim() || null,
    order: s.order ?? i,
  }));
}
