import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { HeldTicketsQueryDto } from './dto/event-held-tickets.dto';

/** The event a held ticket is for, with the fields a ticket screen draws. */
export interface HeldTicketEventView {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date | null;
  /** IANA zone and the label the host chose ("10:00 WAT"); both may be null. */
  timezone: string | null;
  timeLabel: string | null;
  format: string;
  location: string;
  venueName: string | null;
  bannerUrl: string | null;
  status: string;
  cancelledAt: Date | null;
}

export interface HeldTicketStub {
  id: string;
  status: 'valid' | 'checked_in' | 'void';
  checkedInAt: Date | null;
}

/** GET /events/tickets/held: one row per order and tier ("2 x VIP"). */
export interface HeldTicketGroup {
  orderId: string;
  ticketTypeId: string;
  tierName: string;
  quantity: number;
  event: HeldTicketEventView;
  /** Oldest first. The row opens the first one that can still be scanned. */
  tickets: HeldTicketStub[];
}

/** GET /events/tickets/held/:ticketId: one ticket, with the code the door scans. */
export interface HeldTicketView {
  id: string;
  orderId: string;
  /** Exactly what `POST /events/:id/door/check-in` accepts as `code`. */
  code: string;
  status: 'valid' | 'checked_in' | 'void';
  checkedInAt: Date | null;
  tierName: string;
  holderName: string | null;
  event: HeldTicketEventView;
  /** The tickets of the same order and tier, oldest first, this one included. */
  siblings: HeldTicketStub[];
}

const EVENT_SELECT = {
  id: true,
  name: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  timeLabel: true,
  format: true,
  location: true,
  venueName: true,
  bannerUrl: true,
  status: true,
  cancelledAt: true,
} as const;

/**
 * "Past" is the event's own end (`endsAt ?? startsAt`) having gone by, the
 * same rule the public calendar uses, or the event having been called off.
 */
export function isPastEvent(
  event: {
    startsAt: Date;
    endsAt: Date | null;
    cancelledAt: Date | null;
    status: string;
  },
  now: Date,
): boolean {
  if (event.cancelledAt || event.status === 'cancelled') return true;
  return (event.endsAt ?? event.startsAt).getTime() < now.getTime();
}

/**
 * The person's own tickets for the "My tickets" screens (EVENTS-03). New
 * routes beside the protected `GET /events/tickets/mine`, whose answer does
 * not change: these add the order, the event's zone and venue, the holder's
 * name, and the upcoming / past split the screen needs.
 */
@Injectable()
export class EventHeldTicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  async list(
    buyerWawuId: string,
    query: HeldTicketsQueryDto,
  ): Promise<Paginated<HeldTicketGroup>> {
    const rows = await this.prisma.eventTicket.findMany({
      where: { order: { buyerWawuId, status: 'paid' } },
      select: {
        id: true,
        orderId: true,
        ticketTypeId: true,
        status: true,
        checkedInAt: true,
        createdAt: true,
        ticketType: { select: { name: true } },
        event: { select: EVENT_SELECT },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const now = new Date();
    const groups = new Map<string, HeldTicketGroup>();
    for (const r of rows) {
      if (isPastEvent(r.event, now) !== (query.view === 'past')) continue;
      const key = `${r.orderId}:${r.ticketTypeId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          orderId: r.orderId,
          ticketTypeId: r.ticketTypeId,
          tierName: r.ticketType.name,
          quantity: 0,
          event: r.event,
          tickets: [],
        };
        groups.set(key, group);
      }
      group.quantity += 1;
      group.tickets.push({
        id: r.id,
        status: r.status,
        checkedInAt: r.checkedInAt,
      });
    }

    // Upcoming reads forwards from now, past backwards: nearest first.
    const direction = query.view === 'past' ? -1 : 1;
    const ordered = [...groups.values()].sort(
      (a, b) =>
        direction * (a.event.startsAt.getTime() - b.event.startsAt.getTime()) ||
        a.orderId.localeCompare(b.orderId) ||
        a.ticketTypeId.localeCompare(b.ticketTypeId),
    );
    const start = (query.page - 1) * query.perPage;
    return {
      items: ordered.slice(start, start + query.perPage),
      currentPage: query.page,
      perPage: query.perPage,
      total: ordered.length,
    };
  }

  async one(buyerWawuId: string, ticketId: string): Promise<HeldTicketView> {
    // Someone else's ticket, an unpaid order's and an unknown id all read the
    // same: not found. Nothing says whether a ticket exists for another person.
    const ticket = await this.prisma.eventTicket.findFirst({
      where: { id: ticketId, order: { buyerWawuId, status: 'paid' } },
      select: {
        id: true,
        orderId: true,
        ticketTypeId: true,
        code: true,
        status: true,
        checkedInAt: true,
        ticketType: { select: { name: true } },
        event: { select: EVENT_SELECT },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const [siblings, identities] = await Promise.all([
      this.prisma.eventTicket.findMany({
        where: { orderId: ticket.orderId, ticketTypeId: ticket.ticketTypeId },
        select: { id: true, status: true, checkedInAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.wawuId.lookupPublicIdentities([buyerWawuId]),
    ]);
    const identity = identities.get(buyerWawuId);
    const holderName =
      [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim() || null;

    return {
      id: ticket.id,
      orderId: ticket.orderId,
      code: ticket.code,
      status: ticket.status,
      checkedInAt: ticket.checkedInAt,
      tierName: ticket.ticketType.name,
      holderName,
      event: ticket.event,
      siblings,
    };
  }
}
