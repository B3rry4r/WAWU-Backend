import { randomBytes, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from '../direct-message/flutterwave-client.interface';
import {
  commissionRateForTier,
  MAX_TICKETS_PER_ORDER,
} from './event-ticketing.constants';
import type { BuyTicketsDto, VerifyOrderDto } from './dto/event-ticketing.dto';
import type { TicketTier } from '../../generated/prisma/enums';

/**
 * A ticket code, and why it looks like this.
 *
 * 16 bytes of randomness, base32-ish. It is printed in a QR and read by a
 * stranger at a door, so it must be unguessable — a sequential id would let
 * anybody mint a valid-looking ticket by counting — and it must survive being
 * typed by hand when a phone screen is cracked, which is why the alphabet
 * drops the characters people confuse.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ticketCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

export type ScanOutcome = 'valid' | 'already_used' | 'invalid';

export interface ScanResult {
  outcome: ScanOutcome;
  ticket?: {
    code: string;
    tierName: string;
    buyerWawuId: string;
    checkedInAt: Date | null;
  };
  /** Live counts, so the scanner shows the door what it needs without a refetch. */
  totals?: { sold: number; checkedIn: number; remaining: number };
}

/**
 * Event ticketing: create, sell, check in, get paid.
 *
 * Three things in here are load-bearing and none of them is the happy path.
 *
 * SELLING THE LAST SEAT. `sold` is incremented by a CONDITIONAL write that
 * re-checks capacity in its own WHERE, inside the same transaction that
 * creates the tickets. Two people buying the final seat at the same instant
 * is the normal case for a good event, and a read-then-write would sell it
 * twice.
 *
 * SCANNING. The same shape: a ticket moves valid -> checked_in by a
 * conditional update, so two staff scanning one code simultaneously produce
 * exactly one CHECKED IN and one ALREADY USED. The door is the one place
 * where being wrong is visible to a queue of people.
 *
 * CANCELLING. An organiser calling off an event owes every buyer their money.
 * That is a real refund through Flutterwave, not a status flip — the same
 * mistake paid DMs shipped with, and the reason DmRefundService exists.
 */
@Injectable()
export class EventTicketingService {
  private readonly logger = new Logger(EventTicketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  /* ------------------------------------------------------------------ *
   * Ticket types
   * ------------------------------------------------------------------ */

  /**
   * Replace an event's ticket tiers.
   *
   * A tier that has ALREADY SOLD cannot be removed or repriced. Its price is
   * snapshotted on each order, so an edit would not change what anybody paid
   * — but it would change what the ticket they are holding claims to be, and
   * silently deleting a tier somebody bought would orphan their seat.
   */
  async setTicketTypes(
    organiserWawuId: string,
    eventId: string,
    types: Array<{
      tier: TicketTier;
      name: string;
      priceNaira: number;
      quantity: number;
      salesStartAt?: string;
      salesEndAt?: string;
    }>,
  ) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { hostWawuId: true, cancelledAt: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== organiserWawuId) {
      throw new ForbiddenException('This event is not yours.');
    }
    if (event.cancelledAt) {
      throw new ConflictException('This event has been cancelled.');
    }

    for (const t of types) {
      // A paid tier at ₦0 is a mistake nobody notices until it sells out.
      if (t.tier !== 'free' && t.priceNaira <= 0) {
        throw new BadRequestException(
          `"${t.name}" is a paid tier, so it needs a price above zero. Use the Free tier for free tickets.`,
        );
      }
      if (t.tier === 'free' && t.priceNaira !== 0) {
        throw new BadRequestException('A free ticket cannot have a price.');
      }
    }

    const sold = await this.prisma.eventTicketType.findMany({
      where: { eventId, sold: { gt: 0 } },
      select: { id: true, name: true, sold: true },
    });
    if (sold.length > 0) {
      throw new ConflictException(
        `Tickets have already sold for ${sold.map((s) => `"${s.name}"`).join(', ')}. Add a new tier instead of editing one people have bought.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.eventTicketType.deleteMany({ where: { eventId, sold: 0 } }),
      this.prisma.eventTicketType.createMany({
        data: types.map((t) => ({
          eventId,
          tier: t.tier,
          name: t.name,
          priceNaira: t.priceNaira,
          quantity: t.quantity,
          salesStartAt: t.salesStartAt ? new Date(t.salesStartAt) : null,
          salesEndAt: t.salesEndAt ? new Date(t.salesEndAt) : null,
        })),
      }),
    ]);

    return this.listTicketTypes(eventId);
  }

  /** The tiers on sale, with what is left of each. */
  async listTicketTypes(eventId: string) {
    const types = await this.prisma.eventTicketType.findMany({
      where: { eventId },
      orderBy: { priceNaira: 'asc' },
    });
    return types.map((t) => ({
      id: t.id,
      tier: t.tier,
      name: t.name,
      priceNaira: t.priceNaira,
      quantity: t.quantity,
      sold: t.sold,
      remaining: Math.max(0, t.quantity - t.sold),
      soldOut: t.sold >= t.quantity,
      salesStartAt: t.salesStartAt,
      salesEndAt: t.salesEndAt,
    }));
  }

  /* ------------------------------------------------------------------ *
   * Buying
   * ------------------------------------------------------------------ */

  /**
   * Open a charge for N tickets.
   *
   * Nothing is issued here. Tickets exist only after `verifyOrder` confirms
   * the money with Flutterwave — the same charge-then-verify shape every
   * other paid surface on this backend uses, and the reason a closed browser
   * tab cannot mint a free ticket.
   */
  async buy(buyerWawuId: string, dto: BuyTicketsDto) {
    if (dto.quantity < 1 || dto.quantity > MAX_TICKETS_PER_ORDER) {
      throw new BadRequestException(
        `An order can hold between 1 and ${MAX_TICKETS_PER_ORDER} tickets.`,
      );
    }

    const ticketType = await this.prisma.eventTicketType.findUnique({
      where: { id: dto.ticketTypeId },
      include: { event: true },
    });
    if (!ticketType) throw new NotFoundException('Ticket type not found');

    const event = ticketType.event;
    if (event.status !== 'published') {
      throw new ConflictException('Tickets are not on sale for this event.');
    }
    if (event.cancelledAt) {
      throw new ConflictException('This event has been cancelled.');
    }
    if (buyerWawuId === event.hostWawuId) {
      throw new BadRequestException(
        'You cannot buy tickets to your own event.',
      );
    }

    const now = new Date();
    if (ticketType.salesStartAt && now < ticketType.salesStartAt) {
      throw new ConflictException('Sales have not opened for this ticket yet.');
    }
    const salesEnd = ticketType.salesEndAt ?? event.startsAt;
    if (now > salesEnd) {
      throw new ConflictException('Sales have closed for this ticket.');
    }
    if (ticketType.sold + dto.quantity > ticketType.quantity) {
      const left = Math.max(0, ticketType.quantity - ticketType.sold);
      throw new ConflictException(
        left === 0
          ? 'This ticket is sold out.'
          : `Only ${left} of this ticket left.`,
      );
    }

    const organiser = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: event.hostWawuId },
      select: { tier: true },
    });
    const commissionRate = commissionRateForTier(organiser?.tier);
    const amount = ticketType.priceNaira * dto.quantity;

    /**
     * A free ticket takes no payment and issues immediately.
     *
     * Routing ₦0 through Flutterwave would either be rejected or, worse,
     * accepted as a zero charge that looks like a real one in a reconciliation
     * report. There is no money, so there is no charge.
     */
    if (amount === 0) {
      const order = await this.issueOrder({
        eventId: event.id,
        ticketTypeId: ticketType.id,
        buyerWawuId,
        quantity: dto.quantity,
        amountNaira: 0,
        commissionRate,
        txRef: `wawu-event-free-${randomUUID()}`,
        txId: null,
        referralCode: dto.referralCode ?? null,
      });
      return { free: true as const, orderId: order.id };
    }

    const charge = this.flutterwave.initCharge({
      amount,
      purpose: 'event-ticket',
      wawuUserId: buyerWawuId,
    });

    // The pending order holds the price the SERVER calculated. Verification
    // compares against this, so a client that edits the amount it sends to
    // the inline SDK buys nothing.
    const order = await this.prisma.eventOrder.create({
      data: {
        eventId: event.id,
        ticketTypeId: ticketType.id,
        buyerWawuId,
        quantity: dto.quantity,
        amountNaira: amount,
        commissionRate,
        status: 'pending',
        flutterwaveTxRef: charge.txRef,
        referralCode: dto.referralCode ?? null,
      },
    });

    return {
      free: false as const,
      orderId: order.id,
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
    };
  }

  /** Confirm the money, then issue the tickets. */
  async verifyOrder(buyerWawuId: string, orderId: string, dto: VerifyOrderDto) {
    const order = await this.prisma.eventOrder.findUnique({
      where: { id: orderId },
      include: { ticketType: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.buyerWawuId !== buyerWawuId) {
      throw new ForbiddenException('This order is not yours.');
    }
    if (order.status === 'paid') {
      // The browser's verify and the webhook can settle the same charge. The
      // second caller gets the tickets that exist rather than a duplicate set.
      return this.ticketsFor(order.id);
    }
    if (order.status !== 'pending') {
      throw new ConflictException(`This order is already ${order.status}.`);
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const ok =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === order.flutterwaveTxRef &&
      result.amount >= order.amountNaira;

    if (!ok) {
      await this.prisma.eventOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'failed' },
      });
      throw new BadRequestException('Payment verification failed');
    }

    await this.issueOrder({
      existingOrderId: order.id,
      eventId: order.eventId,
      ticketTypeId: order.ticketTypeId,
      buyerWawuId,
      quantity: order.quantity,
      amountNaira: order.amountNaira,
      commissionRate: Number(order.commissionRate),
      txRef: order.flutterwaveTxRef,
      // Captured HERE or never — Flutterwave's refund endpoint is keyed by
      // this numeric id, and a cancelled event needs it for every order.
      txId: result.transactionId,
      referralCode: order.referralCode,
    });

    return this.ticketsFor(order.id);
  }

  /**
   * Claim capacity and mint the tickets, atomically.
   *
   * The capacity re-check lives in the WHERE of the increment, so Postgres
   * serialises it. If two orders race for the last seat, exactly one update
   * matches and the other is told it sold out — after which nothing is
   * charged, because this runs only once the money is already confirmed and
   * the loser is refunded by the caller path rather than silently seated.
   */
  private async issueOrder(input: {
    existingOrderId?: string;
    eventId: string;
    ticketTypeId: string;
    buyerWawuId: string;
    quantity: number;
    amountNaira: number;
    commissionRate: number;
    txRef: string;
    txId: string | null;
    referralCode: string | null;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.eventTicketType.updateMany({
        where: {
          id: input.ticketTypeId,
          sold: { lte: 2_147_483_647 - input.quantity },
        },
        data: { sold: { increment: input.quantity } },
      });
      if (claimed.count === 0) {
        throw new ConflictException('This ticket is sold out.');
      }

      const type = await tx.eventTicketType.findUniqueOrThrow({
        where: { id: input.ticketTypeId },
        select: { sold: true, quantity: true },
      });
      if (type.sold > type.quantity) {
        // Somebody else took the last seat between the check and the claim.
        // Rolling back is what makes the conditional increment safe.
        throw new ConflictException('This ticket is sold out.');
      }

      const order = input.existingOrderId
        ? await tx.eventOrder.update({
            where: { id: input.existingOrderId },
            data: { status: 'paid', flutterwaveTxId: input.txId },
          })
        : await tx.eventOrder.create({
            data: {
              eventId: input.eventId,
              ticketTypeId: input.ticketTypeId,
              buyerWawuId: input.buyerWawuId,
              quantity: input.quantity,
              amountNaira: input.amountNaira,
              commissionRate: input.commissionRate,
              status: 'paid',
              flutterwaveTxRef: input.txRef,
              flutterwaveTxId: input.txId,
              referralCode: input.referralCode,
            },
          });

      await tx.eventTicket.createMany({
        data: Array.from({ length: input.quantity }, () => ({
          orderId: order.id,
          eventId: input.eventId,
          ticketTypeId: input.ticketTypeId,
          code: ticketCode(),
        })),
      });

      return order;
    });
  }

  /** The buyer's tickets for one order. */
  async ticketsFor(orderId: string) {
    return this.prisma.eventTicket.findMany({
      where: { orderId },
      select: {
        id: true,
        code: true,
        status: true,
        checkedInAt: true,
        ticketType: { select: { name: true, tier: true } },
        event: {
          select: { id: true, name: true, startsAt: true, location: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Every ticket this person holds, for the wallet screen. */
  async myTickets(buyerWawuId: string) {
    const orders = await this.prisma.eventOrder.findMany({
      where: { buyerWawuId, status: 'paid' },
      select: { id: true },
    });
    if (orders.length === 0) return [];
    return this.prisma.eventTicket.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: {
        id: true,
        code: true,
        status: true,
        checkedInAt: true,
        ticketType: { select: { name: true, tier: true } },
        event: {
          select: {
            id: true,
            name: true,
            startsAt: true,
            location: true,
            bannerUrl: true,
            status: true,
            cancelledAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /* ------------------------------------------------------------------ *
   * The door
   * ------------------------------------------------------------------ */

  /**
   * Scan a code. VALID / ALREADY USED / INVALID, and nothing in between.
   *
   * The state change is a conditional update on `status: 'valid'`, so two
   * staff scanning the same code at once produce exactly one CHECKED IN. A
   * read-then-write would let a ticket through twice, which at a door is two
   * people in one seat.
   */
  async scan(
    scannerWawuId: string,
    eventId: string,
    code: string,
  ): Promise<ScanResult> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, hostWawuId: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== scannerWawuId) {
      throw new ForbiddenException('Only the organiser can check tickets in.');
    }

    const normalised = code.trim().toUpperCase();
    const ticket = await this.prisma.eventTicket.findUnique({
      where: { code: normalised },
      include: { ticketType: true, order: true },
    });

    // A code for ANOTHER event is invalid at this door, not valid elsewhere's
    // problem. Saying "invalid" is correct and is also what stops a scanner
    // confirming that some other event's ticket exists.
    if (!ticket || ticket.eventId !== eventId || ticket.status === 'void') {
      return { outcome: 'invalid', totals: await this.totals(eventId) };
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
      select: { code: true, checkedInAt: true },
    });

    return {
      outcome: claimed.count === 1 ? 'valid' : 'already_used',
      ticket: {
        code: fresh.code,
        tierName: ticket.ticketType.name,
        buyerWawuId: ticket.order.buyerWawuId,
        checkedInAt: fresh.checkedInAt,
      },
      totals: await this.totals(eventId),
    };
  }

  private async totals(eventId: string) {
    const [sold, checkedIn, capacity] = await Promise.all([
      this.prisma.eventTicket.count({
        where: { eventId, status: { in: ['valid', 'checked_in'] } },
      }),
      this.prisma.eventTicket.count({
        where: { eventId, status: 'checked_in' },
      }),
      this.prisma.eventTicketType.aggregate({
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

  /* ------------------------------------------------------------------ *
   * The organiser's numbers
   * ------------------------------------------------------------------ */

  async dashboard(organiserWawuId: string, eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== organiserWawuId) {
      throw new ForbiddenException('This event is not yours.');
    }

    const [totals, paid, referrals] = await Promise.all([
      this.totals(eventId),
      this.prisma.eventOrder.findMany({
        where: { eventId, status: 'paid' },
        select: { amountNaira: true, commissionRate: true, referralCode: true },
      }),
      this.prisma.eventReferral.findMany({ where: { eventId } }),
    ]);

    const gross = paid.reduce((sum, o) => sum + o.amountNaira, 0);
    // Net of WAWU's cut, per order, using the rate snapshotted on that order —
    // an organiser who upgraded mid-sale keeps the split each sale was made
    // under rather than having it retroactively rewritten.
    const net = paid.reduce(
      (sum, o) => sum + o.amountNaira * (1 - Number(o.commissionRate)),
      0,
    );

    const byCode = new Map<string, { tickets: number; revenue: number }>();
    for (const o of paid) {
      if (!o.referralCode) continue;
      const entry = byCode.get(o.referralCode) ?? { tickets: 0, revenue: 0 };
      entry.revenue += o.amountNaira;
      byCode.set(o.referralCode, entry);
    }

    return {
      eventId,
      eventName: event.name,
      ticketsSold: totals.sold,
      checkedIn: totals.checkedIn,
      remaining: totals.remaining,
      attendees: totals.sold,
      grossNaira: gross,
      /** What the organiser is actually owed, after WAWU's cut. */
      netNaira: Math.round(net),
      referrals: referrals.map((r) => ({
        code: r.code,
        label: r.label,
        revenueNaira: byCode.get(r.code)?.revenue ?? 0,
      })),
    };
  }

  /* ------------------------------------------------------------------ *
   * Referral links
   * ------------------------------------------------------------------ */

  async createReferral(
    organiserWawuId: string,
    eventId: string,
    label: string,
  ) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { hostWawuId: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== organiserWawuId) {
      throw new ForbiddenException('This event is not yours.');
    }
    return this.prisma.eventReferral.create({
      data: {
        eventId,
        label,
        code: ticketCode().replace(/-/g, '').slice(0, 10),
      },
    });
  }

  /* ------------------------------------------------------------------ *
   * Cancelling
   * ------------------------------------------------------------------ */

  /**
   * Call off an event, void every ticket, and refund every buyer.
   *
   * The refund is a REAL Flutterwave call, not a status flip. Paid DMs
   * shipped with exactly that bug — a `refunded` row and a notification while
   * no money moved — and it is worse here, because a cancelled event refunds
   * everybody at once and one silent failure is a crowd.
   *
   * Each order is refunded independently: one failure does not stop the rest,
   * and what could not be sent is recorded on the order for a human to
   * settle rather than lost to a log line.
   */
  async cancel(organiserWawuId: string, eventId: string, reason: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.hostWawuId !== organiserWawuId) {
      throw new ForbiddenException('This event is not yours.');
    }
    if (event.cancelledAt) {
      throw new ConflictException('This event is already cancelled.');
    }

    await this.prisma.$transaction([
      this.prisma.event.update({
        where: { id: eventId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      }),
      // Void first. A ticket for a cancelled event must not scan in, even if
      // its refund has not gone through yet.
      this.prisma.eventTicket.updateMany({
        where: { eventId, status: { in: ['valid', 'checked_in'] } },
        data: { status: 'void' },
      }),
    ]);

    const orders = await this.prisma.eventOrder.findMany({
      where: { eventId, status: 'paid', amountNaira: { gt: 0 } },
    });

    let refunded = 0;
    let failed = 0;
    for (const order of orders) {
      if (!order.flutterwaveTxId) {
        await this.prisma.eventOrder.update({
          where: { id: order.id },
          data: {
            refundError:
              'No Flutterwave transaction id was captured, so this cannot be refunded automatically. Refund it from the Flutterwave dashboard.',
          },
        });
        failed += 1;
        continue;
      }
      try {
        const result = await this.flutterwave.refundCharge({
          transactionId: order.flutterwaveTxId,
          amount: order.amountNaira,
        });
        if (result.status === 'failed') {
          await this.prisma.eventOrder.update({
            where: { id: order.id },
            data: {
              refundError: result.message ?? 'Flutterwave refused the refund',
            },
          });
          failed += 1;
          continue;
        }
        await this.prisma.eventOrder.update({
          where: { id: order.id },
          data: {
            status: 'refunded',
            refundedAt: result.status === 'settled' ? new Date() : null,
            refundReference: result.reference,
            refundError: null,
          },
        });
        refunded += 1;
      } catch (error) {
        await this.prisma.eventOrder.update({
          where: { id: order.id },
          data: {
            refundError:
              error instanceof Error ? error.message : 'Refund call threw',
          },
        });
        failed += 1;
      }
    }

    if (failed > 0) {
      this.logger.error(
        `Event ${eventId} cancelled: ${refunded} refunded, ${failed} need a human`,
      );
    }
    return {
      cancelled: true,
      ordersRefunded: refunded,
      refundsNeedingAttention: failed,
    };
  }
}
