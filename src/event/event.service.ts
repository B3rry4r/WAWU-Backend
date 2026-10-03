import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { VerificationStateService } from '../common/verification/verification-state.service';
import { VerificationPricingService } from '../common/verification/verification-pricing';
import {
  holdsAnyTick,
  unverified as unverifiedState,
  type VerificationState,
} from '../common/verification/verification-state';
import type { IneligibilityReason } from '../verification/verification-view.type';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type {
  EventModel,
  EventSpeakerModel,
} from '../../generated/prisma/models';
import type { TicketTier } from '../../generated/prisma/enums';
import type { PaginationQueryDto } from '../common/dto/pagination.dto';
import {
  initialsFor,
  type EventGoingView,
  type EventSaveView,
  type EventView,
} from './event-view.type';
import type {
  CreateEventDto,
  EventSpeakerDto,
  NewEventTicketTypeDto,
} from './dto/create-event.dto';
import { eventOptions, type EventOptionsView } from './event-options';
import type { UpdateEventDto } from './dto/update-event.dto';
import type { ListEventsQueryDto } from './dto/list-events-query.dto';

type EventWithSpeakers = EventModel & { speakers: EventSpeakerModel[] };

/**
 * Events — the app-facing half. Reinstated 22 Aug 2026 by product-owner
 * decision, reversing the "no Events section" line in WAWU-Web/CLAUDE.md and
 * docs/00_PLATFORM_MAP.md; both documents were amended with that date rather
 * than left contradicting this code.
 *
 * ── NO MONEY MOVES IN THIS FILE ───────────────────────────────────────────────
 * This service never charges, refunds or credits anybody, and never writes a
 * Purchase, a CreditSpend, a CreatorEarnings figure or a payment reference.
 * The one price it writes is a ticket type's, when a host sends the tickets
 * with the event in one submit (EVENTS-02); selling them is
 * EventTicketingService's. "Going" is an interest signal, one row per person.
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationStateService,
    private readonly pricing: VerificationPricingService,
  ) {}

  /**
   * HOSTING AN EVENT IS VERIFIED-ONLY (build brief B3).
   *
   * Enforced here, on the write, and not by hiding a button. A hidden button
   * is a suggestion; this is the rule. A buyer can never host, because a
   * buyer account can hold neither tick. An unverified creator and an
   * unverified professional cannot host either, which is the half that is
   * easy to get wrong: having the right ACCOUNT TYPE is not having the tick.
   *
   * Either tick is enough, and they are not ranked. A verified creator hosts
   * on the strength of the purple tick; a verified professional on the green
   * one; somebody with both does not host twice as hard.
   *
   * The refusal carries a `reason` object, not a bare sentence, so the app
   * can render what this person specifically has to do to become eligible.
   * Being refused for want of a NGN 4,999 purchase and being refused because
   * you are on the wrong kind of account are different problems with
   * different remedies, and a single 403 string cannot tell them apart.
   */
  private async assertMayHost(userWawuId: string): Promise<void> {
    const state: VerificationState = await this.verification.forOne(userWawuId);
    if (holdsAnyTick(state)) return;

    const [profile, professional, prices] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: userWawuId },
        select: { accountType: true },
      }),
      this.prisma.professionalProfile.findFirst({
        where: { wawuUserId: userWawuId, status: 'approved' },
        select: { id: true },
      }),
      this.pricing.prices(),
    ]);

    const isCreator = profile?.accountType === 'creator';
    const isProfessional = Boolean(professional);

    const purchasable: IneligibilityReason['purchasable'] = [];
    if (isCreator) {
      purchasable.push({
        kind: 'creator',
        priceNgn: prices.creator,
        currency: 'NGN',
        termMonths: 12,
      });
    }
    if (isProfessional) {
      purchasable.push({
        kind: 'professional',
        priceNgn: prices.professional,
        currency: 'NGN',
        termMonths: 12,
      });
    }

    const reason: IneligibilityReason =
      purchasable.length > 0
        ? {
            code: 'verification_required',
            message:
              'Only verified accounts can host an event. Get verified and you can submit this one straight away.',
            steps: [
              'Open Settings, then Verification.',
              'Pay for the tick that fits your account. It lasts a year.',
              'Come back and submit your event.',
            ],
            purchasable,
          }
        : {
            code: 'account_type_required',
            message:
              'Hosting an event is for verified creators and verified professionals. This account is neither yet.',
            steps: [
              'Switch to a creator account in Settings, or submit your professional credentials for review.',
              'Once that is done, pay for the tick that fits your account.',
              'Come back and submit your event.',
            ],
            purchasable: [],
          };

    throw new ForbiddenException({
      statusCode: 403,
      message: reason.message,
      reason,
    });
  }

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
      // The column, the submit form and the browse chips all existed; only
      // the query did not, so every ?category= request 400'd on the global
      // forbidNonWhitelisted pipe before reaching this method.
      ...(query.category ? { category: query.category } : {}),
      ...(query.featured === undefined ? {} : { featured: query.featured }),
      // One host's published events. `status: published` above still applies,
      // so this can never leak a pending or rejected submission the way
      // /events/mine (which returns every status to its owner) would.
      ...(query.host ? { hostWawuId: query.host } : {}),
      ...timeWindow(query.view),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        include: { speakers: { orderBy: { order: 'asc' } } },
        // Upcoming reads forwards from now, past reads backwards from now —
        // in both directions the row nearest to today comes first, which is
        // the only ordering a calendar screen can use unpaginated.
        //
        // `trending` orders by how many people have signalled interest, with
        // the calendar order as the tie-break so a page of events nobody has
        // marked yet is still stable rather than arbitrary.
        orderBy:
          query.sort === 'trending'
            ? [
                { going: { _count: 'desc' as const } },
                { startsAt: query.view === 'past' ? 'desc' : ('asc' as const) },
              ]
            : { startsAt: query.view === 'past' ? 'desc' : 'asc' },
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

  /** GET /events/options: the label for every category, format and kind. */
  options(): EventOptionsView {
    return eventOptions();
  }

  /**
   * POST /events: created `pending`, always. There is no path here that
   * publishes.
   *
   * The ticket types, when sent, are created in the same write as the event
   * (EVENTS-02), so a host never has an event in the queue whose tickets
   * failed to save, and the reviewer sees both at once.
   */
  async create(userWawuId: string, dto: CreateEventDto): Promise<EventView> {
    await this.assertMayHost(userWawuId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    assertWindowOrdered(startsAt, endsAt);
    const ticketTypes = ticketTypeRows(dto.ticketTypes);
    const address = dto.address?.trim() || null;

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
        location: dto.location?.trim() || address || '',
        address: dto.address?.trim() ?? null,
        venueName: dto.venueName?.trim() || null,
        externalUrl: dto.externalUrl ?? null,
        bannerUrl: dto.bannerUrl ?? null,
        category: dto.category ?? 'other',
        contactEmail: dto.contactEmail ?? null,
        contactPhone: dto.contactPhone ?? null,
        // status defaults to `pending` in the schema and is deliberately not
        // named here — there is no argument this method could ever take that
        // would make it anything else.
        speakers: { create: speakerRows(dto.speakers) },
        ...(ticketTypes.length > 0
          ? { ticketTypes: { create: ticketTypes } }
          : {}),
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
    // Checked on the edit as well as the create. A tick that lapses after an
    // event was approved must not leave its host with a write path that the
    // create path refuses, and every edit re-enters the moderation queue
    // anyway, so an edit IS a submission.
    await this.assertMayHost(userWawuId);
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
          ...locationUpdate(existing, dto),
          ...(dto.address !== undefined
            ? { address: dto.address.trim() || null }
            : {}),
          ...(dto.venueName !== undefined
            ? { venueName: dto.venueName.trim() || null }
            : {}),
          ...(dto.externalUrl !== undefined
            ? { externalUrl: dto.externalUrl }
            : {}),
          ...(dto.bannerUrl !== undefined ? { bannerUrl: dto.bannerUrl } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.contactEmail !== undefined
            ? { contactEmail: dto.contactEmail }
            : {}),
          ...(dto.contactPhone !== undefined
            ? { contactPhone: dto.contactPhone }
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

  /**
   * POST /events/:id/save — the bookmark in the corner of the card.
   *
   * NOT a second "Going". Keeping an event to look at later and telling the
   * organiser you are coming are different statements, and the screen shows
   * both at once, so folding one into the other would make a private note
   * public. Nothing is charged and no seat is held here either.
   *
   * Idempotent by the same construction markGoing uses: the unique key on
   * (eventId, userWawuId) is the idempotency, so this is an upsert rather
   * than a toggle, and a retried request cannot silently unsave.
   */
  async save(id: string, userWawuId: string): Promise<EventSaveView> {
    await this.loadVisible(id, userWawuId);
    await this.prisma.eventSave.upsert({
      where: { eventId_userWawuId: { eventId: id, userWawuId } },
      update: {},
      create: { eventId: id, userWawuId },
    });
    return { eventId: id, userSaved: true };
  }

  /**
   * DELETE /events/:id/save — remove it. Removing a bookmark that was never
   * there is a 200 describing the true state, not a 404.
   */
  async unsave(id: string, userWawuId: string): Promise<EventSaveView> {
    await this.loadVisible(id, userWawuId);
    await this.prisma.eventSave.deleteMany({
      where: { eventId: id, userWawuId },
    });
    return { eventId: id, userSaved: false };
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

    const [counts, mine, saved, floors, hostTicks] = await Promise.all([
      this.prisma.eventGoing.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.eventGoing.findMany({
        where: { eventId: { in: ids }, userWawuId },
        select: { eventId: true },
      }),
      this.prisma.eventSave.findMany({
        where: { eventId: { in: ids }, userWawuId },
        select: { eventId: true },
      }),
      // The "from" price, DERIVED: the cheapest tier this event offers. One
      // grouped read for the whole page rather than a price column on Event
      // that would go stale the moment a tier is added or repriced.
      this.prisma.eventTicketType.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids } },
        _min: { priceNaira: true },
      }),
      // One batched read for the whole page, not one per row.
      this.verification.forMany(rows.map((r) => r.hostWawuId)),
    ]);

    const countByEvent = new Map(counts.map((c) => [c.eventId, c._count._all]));
    const goingIds = new Set(mine.map((m) => m.eventId));
    const savedIds = new Set(saved.map((m) => m.eventId));
    const floorByEvent = new Map(
      floors.map((f) => [f.eventId, f._min.priceNaira]),
    );

    return rows.map((row) => ({
      id: row.id,
      hostWawuId: row.hostWawuId,
      hostVerification: hostTicks.get(row.hostWawuId) ?? unverifiedState(),
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
      venueName: row.venueName,
      externalUrl: row.externalUrl,
      bannerUrl: row.bannerUrl,
      category: row.category,
      contactEmail: row.contactEmail,
      contactPhone: row.contactPhone,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      hasRecap: Boolean(row.recapUrl ?? row.recapText),
      recapUrl: row.recapUrl,
      recapText: row.recapText,
      featured: row.featured,
      status: row.status,
      goingCount: countByEvent.get(row.id) ?? 0,
      userGoing: goingIds.has(row.id),
      userSaved: savedIds.has(row.id),
      // An event with no ticket types sells nothing, which is still the
      // ordinary case. `null` rather than 0: "free" and "not for sale" are
      // different, and only one of them is an invitation to pay.
      ticketed: floorByEvent.get(row.id) != null,
      priceFromNaira: floorByEvent.get(row.id) ?? null,
      speakers: row.speakers.map((s) => ({
        name: s.name,
        title: s.title,
        photoUrl: s.photoUrl,
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

/**
 * `location` on an edit. Sent, it is stored as sent. Not sent, it follows a
 * new `address` only when it was filled from the address in the first place
 * (empty, or equal to the old address), so a location a host typed is never
 * overwritten by an address edit.
 */
function locationUpdate(
  existing: { location: string; address: string | null },
  dto: UpdateEventDto,
): { location?: string } {
  if (dto.location !== undefined) return { location: dto.location.trim() };
  if (dto.address === undefined) return {};
  const derived =
    existing.location === '' || existing.location === existing.address;
  return derived ? { location: dto.address.trim() } : {};
}

/**
 * The ticket types sent with a new event, as rows.
 *
 * A type with no `tier` is `free` at a price of 0 (R-8) and `regular` at any
 * other price. A type that names its tier is held to the rules
 * PUT /events/:id/tickets applies, with the same words.
 */
function ticketTypeRows(types: NewEventTicketTypeDto[] | undefined) {
  return (types ?? []).map((t) => {
    const name = t.name.trim();
    const tier: TicketTier =
      t.tier ?? (t.priceNaira === 0 ? 'free' : 'regular');
    if (tier !== 'free' && t.priceNaira <= 0) {
      throw new BadRequestException(
        `"${name}" is a paid tier, so it needs a price above zero. Use the Free tier for free tickets.`,
      );
    }
    if (tier === 'free' && t.priceNaira !== 0) {
      throw new BadRequestException('A free ticket cannot have a price.');
    }
    return { tier, name, priceNaira: t.priceNaira, quantity: t.quantity };
  });
}

/** Speaker rows, ordered by the position they arrived in unless one says otherwise. */
function speakerRows(speakers: EventSpeakerDto[] | undefined) {
  return (speakers ?? []).map((s, i) => ({
    name: s.name.trim(),
    title: s.title?.trim() || null,
    photoUrl: s.photoUrl?.trim() || null,
    order: s.order ?? i,
  }));
}
