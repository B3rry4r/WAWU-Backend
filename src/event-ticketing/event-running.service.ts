import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { AddDoorStaffDto } from './dto/event-running.dto';
import {
  SOLD_TICKET_STATUSES,
  soldCounts,
  ticketTotals,
} from './ticket-counts';

/** GET /events/mine/sold: one row per event the caller hosts. */
export interface HostSoldCount {
  eventId: string;
  /** Issued and not voided, counted exactly as E18's `ticketsSold` is. */
  ticketsSold: number;
}

export interface HostSoldCounts {
  items: HostSoldCount[];
}

/** GET /events/:id/referrals: one shared link and what it sold. */
export interface EventReferralSalesView {
  id: string;
  code: string;
  label: string;
  /** Tickets bought through this link and still sold (not voided). */
  ticketsSold: number;
  /** Naira paid on orders through this link, as the dashboard counts it. */
  revenueNaira: number;
  createdAt: Date;
}

/** One person the host lets check tickets in. */
export interface DoorStaffView {
  id: string;
  wawuUserId: string;
  /** What the door result prints after "by" (E23). */
  label: string;
  /** Their name from WAWU ID, else their handle; null when neither is known. */
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  addedAt: Date;
}

/** GET /events/door/mine: an event the caller works the door at. */
export interface DoorEventView {
  eventId: string;
  eventName: string;
  startsAt: Date;
  location: string;
  venueName: string | null;
  status: string;
  cancelledAt: Date | null;
  /** The caller's own door label at this event. */
  label: string;
}

export interface DoorEventList {
  items: DoorEventView[];
}

/** Who let a ticket in: the host, or one of their door staff by label. */
export interface CheckedInByView {
  role: 'host' | 'door_staff';
  /** The door staff label ("Door 1"); null when the host scanned it. */
  label: string | null;
}

export type DoorCheckInOutcome = 'valid' | 'already_used' | 'invalid';

/** POST /events/:id/door/check-in: E20, E23 and E24 in one answer. */
export interface DoorCheckInResult {
  outcome: DoorCheckInOutcome;
  /** Null when the code is not a ticket for this event (E24). */
  ticket: {
    code: string;
    tierName: string;
    /** The ticket holder's name (E20); null when WAWU ID has none to give. */
    holderName: string | null;
    /** When it was let in: just now (E20), or the first time (E23). */
    checkedInAt: Date | null;
    /** Who let it in; null only for a scanner no longer known. */
    checkedInBy: CheckedInByView | null;
  } | null;
  totals: {
    sold: number;
    /** "In the room" (E20). */
    checkedIn: number;
    /** "Still to arrive" (E20): sold, less checked in. */
    stillToArrive: number;
    /** Seats still for sale. */
    remaining: number;
  };
}

/**
 * Running an event (EVENTS-05): the organiser's numbers and the door.
 *
 * Every route here is new. The routes the web calls today
 * (`GET /events/mine`, `GET /events/:id/dashboard`,
 * `POST /events/:id/check-in`) are protected and keep their answers exactly,
 * so the numbers the app needs beside them are served here instead.
 *
 * THE DOOR. The host and the door staff the host added may check tickets in.
 * The state change is the same conditional update the host's own scan uses
 * (`status: 'valid'` in the WHERE), so two people scanning one code at once
 * produce exactly one "let them in" and one "already used".
 */
@Injectable()
export class EventRunningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly blocked: BlockedAccountService,
  ) {}

  /* ------------------------------------------------------------------ *
   * The organiser's numbers
   * ------------------------------------------------------------------ */

  /** Sold per event, for every event the caller hosts (E17's "64 sold"). */
  async mySoldCounts(hostWawuId: string): Promise<HostSoldCounts> {
    const events = await this.prisma.event.findMany({
      where: { hostWawuId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    const ids = events.map((e) => e.id);
    const counts = await soldCounts(this.prisma, ids);
    return {
      items: ids.map((eventId) => ({
        eventId,
        ticketsSold: counts.get(eventId) ?? 0,
      })),
    };
  }

  /**
   * The host's shared links with what each one sold (E18 "3 links ·
   * 22 sales"). A sale is a ticket: an order of three through a link is
   * three sales, and a voided ticket is not a sale.
   */
  async referrals(
    hostWawuId: string,
    eventId: string,
  ): Promise<EventReferralSalesView[]> {
    await this.assertHost(hostWawuId, eventId);
    const [links, orders] = await Promise.all([
      this.prisma.eventReferral.findMany({
        where: { eventId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.eventOrder.findMany({
        where: { eventId, status: 'paid', referralCode: { not: null } },
        select: {
          referralCode: true,
          amountNaira: true,
          _count: {
            select: {
              tickets: { where: { status: { in: SOLD_TICKET_STATUSES } } },
            },
          },
        },
      }),
    ]);
    const byCode = new Map<string, { tickets: number; revenue: number }>();
    for (const o of orders) {
      if (!o.referralCode) continue;
      const entry = byCode.get(o.referralCode) ?? { tickets: 0, revenue: 0 };
      entry.tickets += o._count.tickets;
      entry.revenue += o.amountNaira;
      byCode.set(o.referralCode, entry);
    }
    return links.map((r) => ({
      id: r.id,
      code: r.code,
      label: r.label,
      ticketsSold: byCode.get(r.code)?.tickets ?? 0,
      revenueNaira: byCode.get(r.code)?.revenue ?? 0,
      createdAt: r.createdAt,
    }));
  }

  /* ------------------------------------------------------------------ *
   * Door staff
   * ------------------------------------------------------------------ */

  async listDoorStaff(
    hostWawuId: string,
    eventId: string,
  ): Promise<DoorStaffView[]> {
    await this.assertHost(hostWawuId, eventId);
    const rows = await this.prisma.eventDoorStaff.findMany({
      where: { eventId, removedAt: null },
      orderBy: { addedAt: 'asc' },
    });
    return this.staffViews(rows);
  }

  async addDoorStaff(
    hostWawuId: string,
    eventId: string,
    dto: AddDoorStaffDto,
  ): Promise<DoorStaffView> {
    const event = await this.assertHost(hostWawuId, eventId);
    if (event.cancelledAt) {
      throw new ConflictException('This event has been called off.');
    }
    if (!!dto.wawuUserId === !!dto.handle) {
      throw new BadRequestException(
        'Name the person by their WAWU id or their handle, one of the two.',
      );
    }
    const staffWawuId = dto.wawuUserId
      ? await this.personById(dto.wawuUserId)
      : await this.personByHandle(dto.handle!);
    if (staffWawuId === hostWawuId) {
      throw new BadRequestException(
        'You can already check tickets in at your own event.',
      );
    }
    // A block hides the two people from each other (SETTINGS-04): the same
    // 404 as an account that does not exist, in both directions.
    await this.blocked.assertVisible(
      hostWawuId,
      staffWawuId,
      'We could not find that account.',
    );

    const given = dto.label?.trim();
    let row;
    try {
      // One add at a time per event, so a default "Door n" is never handed
      // out twice and a label is unique among the event's active staff.
      row = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`door-staff:${eventId}`}, 0))`;
        const active = await tx.eventDoorStaff.findMany({
          where: { eventId, removedAt: null },
          select: { label: true },
        });
        const current = await tx.eventDoorStaff.findUnique({
          where: { eventId_staffWawuId: { eventId, staffWawuId } },
        });
        if (current && !current.removedAt) {
          throw new ConflictException(
            'This person is already on your door staff.',
          );
        }
        const taken = new Set(active.map((r) => r.label.toLowerCase()));
        // Someone put back keeps their old label when it is still free.
        let label =
          given ||
          (current && !taken.has(current.label.toLowerCase())
            ? current.label
            : undefined);
        if (label) {
          if (taken.has(label.toLowerCase())) {
            throw new ConflictException(
              'Another person at this door already has that name. Pick a different one.',
            );
          }
        } else {
          // The lowest free number, so a gap left by someone removed is filled.
          let n = 1;
          while (taken.has(`door ${n}`)) n += 1;
          label = `Door ${n}`;
        }
        if (current) {
          return tx.eventDoorStaff.update({
            where: { id: current.id },
            data: { removedAt: null, addedAt: new Date(), label },
          });
        }
        return tx.eventDoorStaff.create({
          data: { eventId, staffWawuId, label },
        });
      });
    } catch (e) {
      if ((e as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException(
          'This person is already on your door staff.',
        );
      }
      throw e;
    }
    return (await this.staffViews([row]))[0];
  }

  /**
   * Take someone off the door. The row stays, marked removed, so a ticket
   * they let in still says who did. Removing someone already removed is the
   * same end state, so it answers the same.
   */
  async removeDoorStaff(
    hostWawuId: string,
    eventId: string,
    staffId: string,
  ): Promise<{ removed: true }> {
    await this.assertHost(hostWawuId, eventId);
    const row = await this.prisma.eventDoorStaff.findFirst({
      where: { id: staffId, eventId },
      select: { id: true, removedAt: true },
    });
    if (!row) throw new NotFoundException('Door staff not found');
    if (!row.removedAt) {
      await this.prisma.eventDoorStaff.update({
        where: { id: row.id },
        data: { removedAt: new Date() },
      });
    }
    return { removed: true };
  }

  /** The events the caller works the door at, soonest first. */
  async myDoorEvents(staffWawuId: string): Promise<DoorEventList> {
    const rows = await this.prisma.eventDoorStaff.findMany({
      where: { staffWawuId, removedAt: null },
      select: {
        label: true,
        event: {
          select: {
            id: true,
            name: true,
            startsAt: true,
            location: true,
            venueName: true,
            status: true,
            cancelledAt: true,
          },
        },
      },
      orderBy: { event: { startsAt: 'asc' } },
    });
    return {
      items: rows.map((r) => ({
        eventId: r.event.id,
        eventName: r.event.name,
        startsAt: r.event.startsAt,
        location: r.event.location,
        venueName: r.event.venueName,
        status: r.event.status,
        cancelledAt: r.event.cancelledAt,
        label: r.label,
      })),
    };
  }

  /* ------------------------------------------------------------------ *
   * The door
   * ------------------------------------------------------------------ */

  async checkIn(
    scannerWawuId: string,
    eventId: string,
    code: string,
  ): Promise<DoorCheckInResult> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, hostWawuId: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== scannerWawuId) {
      const staff = await this.prisma.eventDoorStaff.findUnique({
        where: {
          eventId_staffWawuId: { eventId, staffWawuId: scannerWawuId },
        },
        select: { removedAt: true },
      });
      if (!staff || staff.removedAt) {
        throw new ForbiddenException(
          'Only the organiser or their door staff can check tickets in.',
        );
      }
    }

    const normalised = code.trim().toUpperCase();
    const ticket = await this.prisma.eventTicket.findUnique({
      where: { code: normalised },
      select: {
        id: true,
        eventId: true,
        status: true,
        ticketType: { select: { name: true } },
        order: { select: { buyerWawuId: true } },
      },
    });

    // A code for another event is not a ticket at this door (E24), and
    // saying so confirms nothing about the other event.
    if (!ticket || ticket.eventId !== eventId || ticket.status === 'void') {
      return {
        outcome: 'invalid',
        ticket: null,
        totals: await this.doorTotals(eventId),
      };
    }

    const claimed = await this.prisma.eventTicket.updateMany({
      where: { id: ticket.id, status: 'valid' },
      data: {
        status: 'checked_in',
        checkedInAt: new Date(),
        checkedInBy: scannerWawuId,
      },
    });

    const fresh = await this.prisma.eventTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { code: true, checkedInAt: true, checkedInBy: true },
    });

    const [names, checkedInBy, totals] = await Promise.all([
      this.names([ticket.order.buyerWawuId]),
      this.checkedInBy(event.id, event.hostWawuId, fresh.checkedInBy),
      this.doorTotals(eventId),
    ]);

    return {
      outcome: claimed.count === 1 ? 'valid' : 'already_used',
      ticket: {
        code: fresh.code,
        tierName: ticket.ticketType.name,
        holderName: names.get(ticket.order.buyerWawuId)?.displayName ?? null,
        checkedInAt: fresh.checkedInAt,
        checkedInBy,
      },
      totals,
    };
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  private async doorTotals(eventId: string) {
    const t = await ticketTotals(this.prisma, eventId);
    return {
      sold: t.sold,
      checkedIn: t.checkedIn,
      stillToArrive: Math.max(0, t.sold - t.checkedIn),
      remaining: t.remaining,
    };
  }

  private async checkedInBy(
    eventId: string,
    hostWawuId: string,
    scannerWawuId: string | null,
  ): Promise<CheckedInByView | null> {
    if (!scannerWawuId) return null;
    if (scannerWawuId === hostWawuId) return { role: 'host', label: null };
    const staff = await this.prisma.eventDoorStaff.findUnique({
      where: { eventId_staffWawuId: { eventId, staffWawuId: scannerWawuId } },
      select: { label: true },
    });
    return staff ? { role: 'door_staff', label: staff.label } : null;
  }

  /** The event, when the caller is its host. */
  private async assertHost(hostWawuId: string, eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { hostWawuId: true, cancelledAt: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== hostWawuId) {
      throw new ForbiddenException('This event is not yours.');
    }
    return event;
  }

  /** Someone this service or WAWU ID knows, as ChatService checks. */
  private async personById(wawuUserId: string): Promise<string> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (profile) return wawuUserId;
    const identities = await this.wawuId.lookupPublicIdentities([wawuUserId]);
    if (!identities.has(wawuUserId)) {
      throw new NotFoundException('We could not find that account.');
    }
    return wawuUserId;
  }

  private async personByHandle(handle: string): Promise<string> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { handle: handle.replace(/^@/, '') },
      select: { wawuUserId: true },
    });
    if (!profile) {
      throw new NotFoundException('We could not find that account.');
    }
    return profile.wawuUserId;
  }

  /**
   * Name, handle and avatar per person: the name from WAWU ID, the rest from
   * the profile, the way chats and saved recipients read people. WAWU ID
   * being unreachable degrades the name to the handle.
   */
  private async names(ids: string[]): Promise<
    Map<
      string,
      {
        displayName: string | null;
        handle: string | null;
        avatarUrl: string | null;
      }
    >
  > {
    const unique = [...new Set(ids)];
    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: { wawuUserId: true, handle: true, avatarUrl: true },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const out = new Map<
      string,
      {
        displayName: string | null;
        handle: string | null;
        avatarUrl: string | null;
      }
    >();
    for (const id of unique) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const name = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        displayName: name || profile?.handle || null,
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
      });
    }
    return out;
  }

  private async staffViews(
    rows: Array<{
      id: string;
      staffWawuId: string;
      label: string;
      addedAt: Date;
    }>,
  ): Promise<DoorStaffView[]> {
    if (rows.length === 0) return [];
    const people = await this.names(rows.map((r) => r.staffWawuId));
    return rows.map((r) => {
      const p = people.get(r.staffWawuId);
      return {
        id: r.id,
        wawuUserId: r.staffWawuId,
        label: r.label,
        displayName: p?.displayName ?? null,
        handle: p?.handle ?? null,
        avatarUrl: p?.avatarUrl ?? null,
        addedAt: r.addedAt,
      };
    });
  }
}
