import type { PrismaService } from '../common/prisma/prisma.service';
import type { EventTicketStatus } from '../../generated/prisma/enums';

/**
 * What "sold" means, in one place (EVENTS-05).
 *
 * A ticket is sold while it is issued and not voided: `valid` (not in yet) or
 * `checked_in`. A voided ticket (the event was called off, the order
 * refunded) is not sold any more. The organiser dashboard (E18), the door
 * (E20) and My events (E17) all count through here, so the three can never
 * show a host two different numbers for the same event.
 */
export const SOLD_TICKET_STATUSES: EventTicketStatus[] = [
  'valid',
  'checked_in',
];

type CountReader = Pick<PrismaService, 'eventTicket' | 'eventTicketType'>;

export interface TicketTotals {
  sold: number;
  checkedIn: number;
  /** Seats still for sale: every tier's quantity, less what is sold. */
  remaining: number;
}

/** Sold, checked in and left for one event. */
export async function ticketTotals(
  prisma: CountReader,
  eventId: string,
): Promise<TicketTotals> {
  const [sold, checkedIn, capacity] = await Promise.all([
    prisma.eventTicket.count({
      where: { eventId, status: { in: SOLD_TICKET_STATUSES } },
    }),
    prisma.eventTicket.count({
      where: { eventId, status: 'checked_in' },
    }),
    prisma.eventTicketType.aggregate({
      where: { eventId },
      _sum: { quantity: true },
    }),
  ]);
  return {
    sold,
    checkedIn,
    remaining: Math.max(0, (capacity._sum.quantity ?? 0) - sold),
  };
}

/** Sold per event, for many events in one query. An event with none reads 0. */
export async function soldCounts(
  prisma: CountReader,
  eventIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>(eventIds.map((id) => [id, 0]));
  if (eventIds.length === 0) return out;
  const rows = await prisma.eventTicket.groupBy({
    by: ['eventId'],
    where: { eventId: { in: eventIds }, status: { in: SOLD_TICKET_STATUSES } },
    _count: { _all: true },
  });
  for (const row of rows) out.set(row.eventId, row._count._all);
  return out;
}
