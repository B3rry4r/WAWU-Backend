import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { NoticeFacts } from '../../notice-mail/notice-facts';
import { noticeKey, NoticeMailer } from '../../notice-mail/notice-mailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { WalletGate, type OpenWallet } from '../../money/gate/wallet-gate';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { koboNumber } from '../../money/ledger/ledger.service';
import { loadMoneyParties } from '../../money/money-party';
import { MoneyError } from '../../money/money-error';
import type {
  HoldStatus,
  MoneyPartyView,
  PaymentStatus,
  PaymentView,
} from '../../money/money-view.type';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { currentPaySource } from '../../money/payments/pay-source-context';
import {
  FINISHING_MESSAGE,
  foreignCode,
  requireNairaWallet,
  STILL_CONFIRMING_MESSAGE,
  WalletPaymentService,
} from '../../money/payments/wallet-payment.service';
import { isUniqueViolationOn } from '../../money/prisma-unique';
import {
  MAX_TICKETS_PER_ORDER,
  commissionRate,
} from '../event-ticketing.constants';
import { ticketCode, TIER_CHANGED } from '../event-ticketing.service';
import type { CreateEventWalletOrderDto } from './event-wallet-order.dto';
import {
  type BasketAsk,
  type BuyableTier,
  buyRefusal,
  distinctLines,
  EVENT_NOT_FOUND_MESSAGE,
  EVENT_ORDER_PAY_ROUTE,
  CANCELLED_MESSAGE,
  EVENT_TICKET_PAYMENT_KIND,
  KEY_MALFORMED_MESSAGE,
  KEY_PATTERN,
  KEY_REUSED_MESSAGE,
  newOrderReference,
  OPEN_ORDERS_SETTING,
  ORDER_CHANGED_MESSAGE,
  ORDER_FAILED_MESSAGE,
  ORDER_FAILED_RETURNED_REASON,
  ORDER_FAILED_RETURNING_REASON,
  ORDER_LIMIT_MESSAGE,
  ORDER_PAID_MESSAGE,
  ORDER_REFUNDED_RETURNED_REASON,
  ORDER_REFUNDED_RETURNING_REASON,
  orderNotFound,
  overOrderLimit,
  progressOf,
  TICKET_NOT_FOUND_MESSAGE,
  totalNairaOf,
  walletOrderTxRef,
} from './event-wallet-order-rules';
import type {
  EventOrderReturnView,
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from './event-wallet-order-view.type';

/**
 * An order that failed after the debit gives the buyer back everything the
 * payment took, the provider's charge included, and WAWU carries the charge
 * (EVENTS-07 round 2, as a failed bill does). Only the amount of the move
 * differs from a plain refund.
 */
const RETURN_ALL = { returnCharge: true } as const;
const FAILED_REFUND_REASON = 'the order could not be completed';

/** What an order is read with: its basket and the event it is for. */
const ORDER_INCLUDE = {
  lines: { orderBy: [{ unitPriceNaira: 'asc' }, { tierName: 'asc' }] },
  event: {
    select: {
      id: true,
      hostWawuId: true,
      name: true,
      status: true,
      cancelledAt: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      timeLabel: true,
      location: true,
      venueName: true,
      bannerUrl: true,
    },
  },
} satisfies Prisma.EventOrderInclude;

type OrderRow = Prisma.EventOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** The event columns the buying rules and the order's view read. */
type BasketEntry = { tier: TierRow; quantity: number };
type TierRow = BuyableTier & { id: string };

/** Thrown inside the issuing transaction to roll it back: the last seats went. */
class SoldOut extends Error {
  constructor(readonly tierName: string) {
    super(`${tierName} sold out`);
  }
}

/** Thrown inside the issuing transaction before anything is written: the host called the event off (EVENTS-10). */
class CalledOff extends Error {
  constructor() {
    super('the event was called off');
  }
}

/**
 * Event tickets paid from the wallet (task EVENTS-07, E2 to E5 and E10).
 *
 * - **The web is untouched.** `POST /events/:id/orders` and
 *   `POST /events/orders/:orderId/verify` keep their Flutterwave charge and
 *   answers; these routes sit under `events/:id/orders/wallet` and
 *   `events/orders/wallet`, paths no route of the web matches. A wallet order
 *   is an `EventOrder` row too (so My tickets, the door and the organiser's
 *   numbers read it as they read any order), with `paymentProvider = 'wallet'`
 *   and a provider-neutral `paymentReference`.
 * - **A basket.** One order holds a line per ticket type (E2: Regular and VIP
 *   in one payment), priced by the server from the tiers, never by the app.
 * - **A free basket (R-8)** issues its tickets in the request: no wallet, no
 *   PIN, no payment, no debit. The same Idempotency-Key and basket answer the
 *   same order, so a double tap issues one set.
 * - **A paid basket** is a held `event_ticket` payment (R-19): the price
 *   (the tickets, not the provider's charge, R-10) moves into WAWU's own
 *   account, the provider's charge is on top, and the price waits there until
 *   the event. The 85/15 split (R-5) is recorded with the payment; paying the
 *   host's share is WALLET-17's and refunding a called-off event is
 *   EVENTS-10's, both through the hold this service records on the order.
 * - **Nothing is held across a call.** Prices and seats are checked at the
 *   quote, again inside the payment's claim, and the seats are taken in one
 *   short transaction after the debit is confirmed (`onCompleted`), never
 *   while the provider or WAWU ID is being called.
 * - **At least once, idempotent.** `onCompleted` runs from the request and
 *   from the payment sweep, on any server. The order is claimed by one
 *   conditional update inside the issuing transaction, so the tickets are
 *   made once; a payment the order cannot use (the seats went in between, the
 *   event was called off, another payment already paid the order) is refunded
 *   through its hold.
 */
@Injectable()
export class EventWalletOrderService implements OnModuleInit {
  private readonly logger = new Logger(EventWalletOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly gate: WalletGate,
    private readonly blocked: BlockedAccountService,
    private readonly wawuId: WawuIdClient,
    private readonly settings: PlanSettingsService,
    /** Optional so the specs that build this by hand need no mailer; the module always provides both. */
    @Optional() private readonly mail?: NoticeMailer,
    @Optional() private readonly facts?: NoticeFacts,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: EVENT_TICKET_PAYMENT_KIND,
      resolve: (lookup) => this.resolve(lookup),
      beforeClaim: (lookup, tx) => this.assertUnderLimit(lookup, tx),
      onCompleted: (payment) => this.onCompleted(payment),
    });
    this.payments.presentRoute(EVENT_ORDER_PAY_ROUTE, (view) =>
      this.present(view),
    );
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /**
   * Makes an order from what the buyer picked (E2) and answers E3: the order
   * priced by the server and the wallet payment's quote. A basket that costs
   * nothing is issued here and answered `paid` with no quote. Nothing is
   * reserved and nothing is debited by a priced basket.
   */
  async create(
    buyerWawuId: string,
    eventId: string,
    dto: CreateEventWalletOrderDto,
    key?: string,
  ): Promise<EventWalletOrderQuoteView> {
    if (key !== undefined && !KEY_PATTERN.test(key)) {
      throw new MoneyError('idempotency_key_required', KEY_MALFORMED_MESSAGE);
    }
    const asks = distinctLines(dto.lines);
    if (asks === null) {
      throw new BadRequestException(['lines must name each ticket type once.']);
    }
    if (overOrderLimit(asks)) {
      throw new BadRequestException([
        `An order can hold between 1 and ${MAX_TICKETS_PER_ORDER} tickets.`,
      ]);
    }

    if (key !== undefined) {
      const again = await this.sameKey(buyerWawuId, key, eventId, asks);
      if (again) return this.answerFor(buyerWawuId, again);
    }

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        hostWawuId: true,
        status: true,
        cancelledAt: true,
        startsAt: true,
      },
    });
    if (!event)
      throw new MoneyError('target_not_found', EVENT_NOT_FOUND_MESSAGE);
    await this.visible(buyerWawuId, event.hostWawuId);
    const basket = await this.basketOf(event.id, asks);
    const refusal = buyRefusal(event, buyerWawuId, basket, new Date());
    if (refusal) throw refusal;

    const totalNaira = totalNairaOf(
      basket.map((b) => ({
        priceNaira: b.tier.priceNaira,
        quantity: b.quantity,
      })),
    );
    // The most open paid orders one buyer holds on one event (EVENTS-13). A
    // free basket costs nothing to refund and is never counted. This is the
    // early, plain refusal; the payment's claim checks it again, under a lock,
    // which is what holds when orders are paid at once.
    if (totalNaira > 0) {
      const open = await this.openOrders(this.prisma, buyerWawuId, event.id);
      if (open >= this.openOrderLimit()) {
        throw new MoneyError('event_order_limit', ORDER_LIMIT_MESSAGE);
      }
    }
    // A basket that costs nothing needs no wallet (R-8). A priced one needs
    // an open wallet before an order is made: 409 wallet_not_open or
    // wallet_opening, and the app leads to Open your wallet.
    const wallet =
      totalNaira === 0 ? null : await this.gate.requireOpenOrWorld(buyerWawuId);
    // PAY-FX (R-91): a person who opened from outside Nigeria has no naira
    // account. With no account named to pay from (`X-Pay-Source-Currency`)
    // nothing could pay the order, so it is refused here, before one exists.
    if (wallet !== null && !foreignCode(currentPaySource())) {
      requireNairaWallet(wallet);
    }

    let order: OrderRow;
    try {
      order = await this.make(buyerWawuId, event.id, basket, {
        free: totalNaira === 0,
        referralCode: dto.referralCode ?? null,
        requestKey: key ?? null,
      });
    } catch (e) {
      if (key !== undefined && isUniqueViolationOn(e, 'requestKey')) {
        // Two taps at once under one key: the first one's order is the answer.
        const again = await this.sameKey(buyerWawuId, key, eventId, asks);
        if (again) return this.answerFor(buyerWawuId, again);
      }
      if (e instanceof SoldOut) {
        throw new MoneyError(
          'target_not_payable',
          `${e.tierName} just sold out.`,
        );
      }
      if (e instanceof CalledOff) {
        throw new MoneyError('target_not_payable', CANCELLED_MESSAGE);
      }
      throw e;
    }
    if (wallet === null) {
      return { order: await this.viewOf(order), payment: null };
    }
    return this.quoteOf(wallet, order);
  }

  /** The order's quote again: E3 reopened, or a quote past its `expiresAt`. */
  async quote(
    wallet: OpenWallet,
    orderId: string,
  ): Promise<EventWalletOrderQuoteView> {
    const order = await this.owned(wallet.wawuUserId, orderId);
    return this.quoteOf(wallet, order);
  }

  /** Pays the order from the wallet (E3 Pay, E4 PIN). Answers and replays as the order. */
  async pay(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: { orderId: string; expectedTotalKobo: number; quoteToken: string },
  ): Promise<EventWalletOrderView> {
    const order = await this.owned(wallet.wawuUserId, dto.orderId, ['wallet']);
    const payment = await this.payments.pay(
      wallet,
      {
        kind: EVENT_TICKET_PAYMENT_KIND,
        targetId: order.id,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as EventWalletOrderView | undefined) ??
      this.present(payment)
    );
  }

  /** One order as it stands (E5's tickets, E10's Refresh). Only its buyer reads it. */
  async read(
    buyerWawuId: string,
    orderId: string,
  ): Promise<EventWalletOrderView> {
    return this.viewOf(await this.owned(buyerWawuId, orderId));
  }

  private async owned(
    buyerWawuId: string,
    id: string,
    providers: string[] = ['wallet', 'free'],
  ): Promise<OrderRow> {
    const order = await this.prisma.eventOrder.findFirst({
      where: { id, buyerWawuId, paymentProvider: { in: providers } },
      include: ORDER_INCLUDE,
    });
    if (!order) throw orderNotFound();
    return order;
  }

  // -------------------------------------------------------------------------
  // Making an order
  // -------------------------------------------------------------------------

  /** The event is a 404 for a buyer who is blocked either way, as the web's tiers are. */
  private async visible(buyer: string, host: string): Promise<void> {
    try {
      await this.blocked.assertVisible(buyer, host, EVENT_NOT_FOUND_MESSAGE);
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new MoneyError('target_not_found', EVENT_NOT_FOUND_MESSAGE);
      }
      throw e;
    }
  }

  /** The tiers asked for, which must all be this event's, cheapest first. */
  private async basketOf(
    eventId: string,
    asks: readonly BasketAsk[],
  ): Promise<BasketEntry[]> {
    const tiers = await this.prisma.eventTicketType.findMany({
      where: { id: { in: asks.map((a) => a.ticketTypeId) }, eventId },
      select: {
        id: true,
        name: true,
        priceNaira: true,
        quantity: true,
        sold: true,
        salesStartAt: true,
        salesEndAt: true,
        retiredAt: true,
      },
    });
    const byId = new Map(tiers.map((t) => [t.id, t]));
    const basket: BasketEntry[] = [];
    for (const ask of asks) {
      const tier = byId.get(ask.ticketTypeId);
      if (!tier) {
        throw new MoneyError('target_not_found', TICKET_NOT_FOUND_MESSAGE);
      }
      // EVENTS-11: a tier the host replaced while orders pointed at it is
      // retired, not on sale. It cannot be bought again, whoever picked it
      // before the host changed it.
      if (tier.retiredAt) {
        throw new MoneyError('target_not_payable', TIER_CHANGED);
      }
      basket.push({ tier, quantity: ask.quantity });
    }
    return basket.sort(
      (a, b) =>
        a.tier.priceNaira - b.tier.priceNaira ||
        a.tier.name.localeCompare(b.tier.name) ||
        a.tier.id.localeCompare(b.tier.id),
    );
  }

  /**
   * Writes the order and its lines; a free one is issued in the same
   * transaction (its seats taken, its tickets made). One short transaction,
   * the database only.
   */
  private async make(
    buyerWawuId: string,
    eventId: string,
    basket: readonly BasketEntry[],
    opts: {
      free: boolean;
      referralCode: string | null;
      requestKey: string | null;
    },
  ): Promise<OrderRow> {
    const totalNaira = totalNairaOf(
      basket.map((b) => ({
        priceNaira: b.tier.priceNaira,
        quantity: b.quantity,
      })),
    );
    const first = basket[0];
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = randomUUID();
      try {
        return await this.prisma.$transaction(async (tx) => {
          if (!opts.free) await this.assertTiersOnSale(tx, basket);
          if (opts.free) {
            // EVENTS-13: the same share lock on the event row as `issue`, so
            // a host's cancel and a free order take turns: either the cancel
            // comes second and voids these tickets, or it came first and no
            // order is made for a called-off event.
            await this.assertNotCalledOff(tx, eventId);
            await this.takeSeats(tx, basket);
          }
          const created = await tx.eventOrder.create({
            data: {
              id,
              eventId,
              ticketTypeId: first.tier.id,
              buyerWawuId,
              quantity: basket.reduce((n, b) => n + b.quantity, 0),
              amountNaira: totalNaira,
              commissionRate: commissionRate(),
              status: opts.free ? 'paid' : 'pending',
              flutterwaveTxRef: walletOrderTxRef(id),
              referralCode: opts.referralCode,
              paymentProvider: opts.free ? 'free' : 'wallet',
              paymentReference: newOrderReference(),
              requestKey: opts.requestKey,
              paidAt: opts.free ? now : null,
              lines: {
                createMany: {
                  data: basket.map((b) => ({
                    ticketTypeId: b.tier.id,
                    tierName: b.tier.name,
                    unitPriceNaira: b.tier.priceNaira,
                    quantity: b.quantity,
                  })),
                },
              },
              ...(opts.free
                ? {
                    tickets: {
                      createMany: {
                        data: basket.flatMap((b) =>
                          Array.from({ length: b.quantity }, () => ({
                            eventId,
                            ticketTypeId: b.tier.id,
                            code: ticketCode(),
                          })),
                        ),
                      },
                    },
                  }
                : {}),
            },
            include: ORDER_INCLUDE,
          });
          return created;
        });
      } catch (e) {
        // A reference another order already has: try another. Anything else,
        // the caller's (a repeated key, the last seats gone).
        if (!isUniqueViolationOn(e, 'paymentReference')) throw e;
      }
    }
    throw new Error('EventOrder: no free reference after three tries.');
  }

  /**
   * EVENTS-11: before a priced order is written, locks its tier rows FOR SHARE
   * (in id order, the order the host's tier edit and the seat taking use) and
   * checks, under the lock, that each is still there and not retired. A host's
   * edit that replaces a tier either commits first, and this order is refused
   * (409 target_not_payable, "has changed"), or waits for this one and then
   * sees an order that names the tier. An order is never written against a
   * tier row that is going away. A free basket does not need it: it takes the
   * event row's share lock and its seats in this same transaction.
   */
  private async assertTiersOnSale(
    tx: Prisma.TransactionClient,
    basket: readonly BasketEntry[],
  ): Promise<void> {
    const ids = basket.map((b) => b.tier.id);
    const rows = await tx.$queryRaw<
      Array<{ id: string; retiredAt: Date | null }>
    >`SELECT "id", "retiredAt" FROM "EventTicketType" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR SHARE`;
    if (rows.length !== ids.length || rows.some((r) => r.retiredAt)) {
      throw new MoneyError('target_not_payable', TIER_CHANGED);
    }
  }

  /**
   * Reads the event row under a share lock (a cancel's update waits for it,
   * and it waits for a cancel's) and throws `CalledOff` when the host has
   * called the event off, or it is not on sale. Database only.
   */
  private async assertNotCalledOff(
    tx: Prisma.TransactionClient,
    eventId: string,
  ): Promise<void> {
    const [event] = await tx.$queryRaw<
      Array<{ cancelledAt: Date | null; status: string }>
    >`SELECT "cancelledAt", "status"::text AS "status" FROM "Event" WHERE "id" = ${eventId} FOR SHARE`;
    if (!event || event.cancelledAt !== null || event.status !== 'published') {
      throw new CalledOff();
    }
  }

  // -------------------------------------------------------------------------
  // The order limit (EVENTS-13)
  // -------------------------------------------------------------------------

  /** The most open paid orders one buyer may hold on one event: the admin setting, read with no restart. */
  private openOrderLimit(): number {
    return this.settings.number(OPEN_ORDERS_SETTING);
  }

  /**
   * How many paid wallet orders the buyer holds on the event: the ones paid
   * and not refunded or failed, plus the ones whose payment is claimed and
   * not yet delivered (the debit may be in flight). A free order is not a
   * wallet order. `exceptOrderId` leaves out the order being paid now.
   */
  private async openOrders(
    db: Prisma.TransactionClient,
    buyerWawuId: string,
    eventId: string,
    exceptOrderId?: string,
  ): Promise<number> {
    const claimed = await db.walletPayment.findMany({
      where: {
        payerWawuUserId: buyerWawuId,
        kind: EVENT_TICKET_PAYMENT_KIND,
        openKey: { not: null },
      },
      select: { targetId: true },
    });
    return db.eventOrder.count({
      where: {
        buyerWawuId,
        eventId,
        paymentProvider: 'wallet',
        ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}),
        OR: [
          { status: 'paid' },
          { status: 'pending', id: { in: claimed.map((c) => c.targetId) } },
        ],
      },
    });
  }

  /**
   * Inside the payment's claim (PayableKindHandler.beforeClaim): takes one
   * short advisory lock for this buyer and this event, counts, and refuses
   * the order that would be one too many. Two orders of one buyer claimed at
   * once take turns on the lock, and the second counts the first's claim
   * (committed with its transaction), so a buyer never holds more than the
   * setting. Nothing is recorded when it refuses and nothing is sent: the
   * transaction is database only.
   */
  private async assertUnderLimit(
    lookup: PayableLookup,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const order = await tx.eventOrder.findFirst({
      where: {
        id: lookup.targetId,
        buyerWawuId: lookup.payerWawuUserId,
        paymentProvider: 'wallet',
      },
      select: { id: true, eventId: true },
    });
    // No such order: `resolve` has already refused it, or is about to.
    if (!order) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`event-orders:${lookup.payerWawuUserId}:${order.eventId}`}, 0))`;
    const open = await this.openOrders(
      tx,
      lookup.payerWawuUserId,
      order.eventId,
      order.id,
    );
    if (open >= this.openOrderLimit()) {
      throw new MoneyError('event_order_limit', ORDER_LIMIT_MESSAGE);
    }
  }

  /**
   * Takes the seats, each line by a conditional update that re-checks the
   * tier's capacity in its own WHERE, so two buyers of the last seat cannot
   * both have it. Lines go in id order, so two baskets of the same tiers
   * never wait on each other in opposite orders.
   */
  private async takeSeats(
    tx: Prisma.TransactionClient,
    basket: ReadonlyArray<{
      tier: { id: string; name: string };
      quantity: number;
    }>,
  ): Promise<void> {
    const ids = basket.map((b) => b.tier.id);
    const capacity = new Map(
      (
        await tx.eventTicketType.findMany({
          where: { id: { in: ids } },
          select: { id: true, quantity: true },
        })
      ).map((t) => [t.id, t.quantity]),
    );
    for (const line of [...basket].sort((a, b) =>
      a.tier.id.localeCompare(b.tier.id),
    )) {
      const room = (capacity.get(line.tier.id) ?? 0) - line.quantity;
      const claimed =
        room < 0
          ? { count: 0 }
          : await tx.eventTicketType.updateMany({
              where: { id: line.tier.id, sold: { lte: room } },
              data: { sold: { increment: line.quantity } },
            });
      if (claimed.count === 0) throw new SoldOut(line.tier.name);
    }
  }

  /** An order already made under this key by this buyer: the same basket answers it, another is a reuse. */
  private async sameKey(
    buyerWawuId: string,
    key: string,
    eventId: string,
    asks: readonly BasketAsk[],
  ): Promise<OrderRow | null> {
    const existing = await this.prisma.eventOrder.findUnique({
      where: { buyerWawuId_requestKey: { buyerWawuId, requestKey: key } },
      include: ORDER_INCLUDE,
    });
    if (!existing) return null;
    const same =
      existing.eventId === eventId &&
      existing.lines.length === asks.length &&
      asks.every((a) =>
        existing.lines.some(
          (l) => l.ticketTypeId === a.ticketTypeId && l.quantity === a.quantity,
        ),
      );
    if (!same)
      throw new MoneyError('idempotency_key_reused', KEY_REUSED_MESSAGE);
    return existing;
  }

  /** What a repeated creation answers: the order as it stands, with its quote while it is open. */
  private async answerFor(
    buyerWawuId: string,
    order: OrderRow,
  ): Promise<EventWalletOrderQuoteView> {
    if (order.paymentProvider === 'free' || order.status !== 'pending') {
      return { order: await this.viewOf(order), payment: null };
    }
    const wallet = await this.gate.requireOpenOrWorld(buyerWawuId);
    return this.quoteOf(wallet, order);
  }

  // -------------------------------------------------------------------------
  // Paying: what the payment service asks of the order
  // -------------------------------------------------------------------------

  /**
   * The price and the payee of an order (E3). The price is the tickets, in
   * kobo; the provider's charge is the fee quote's, on top (R-10). Asked more
   * than once for one payment, and again inside the payment's claim, so the
   * order is checked against the tiers each time: a price that changed, seats
   * that went, an event called off or closed makes it `target_not_payable`
   * and nothing is taken.
   */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const order = await this.owned(lookup.payerWawuUserId, lookup.targetId, [
      'wallet',
    ]);
    if (order.status !== 'pending') {
      throw new MoneyError(
        'target_not_payable',
        order.status === 'paid' ? ORDER_PAID_MESSAGE : ORDER_FAILED_MESSAGE,
      );
    }
    await this.stillBuyable(order);
    return {
      title: order.event.name,
      priceKobo: order.amountNaira * 100,
      payee: await this.host(order.event.hostWawuId),
    };
  }

  private async stillBuyable(order: OrderRow): Promise<void> {
    const tiers = await this.prisma.eventTicketType.findMany({
      where: { id: { in: order.lines.map((l) => l.ticketTypeId) } },
      select: {
        id: true,
        name: true,
        priceNaira: true,
        quantity: true,
        sold: true,
        salesStartAt: true,
        salesEndAt: true,
      },
    });
    const byId = new Map(tiers.map((t) => [t.id, t]));
    const basket: BasketEntry[] = [];
    for (const line of order.lines) {
      const tier = byId.get(line.ticketTypeId);
      if (!tier || tier.priceNaira !== line.unitPriceNaira) {
        throw new MoneyError('target_not_payable', ORDER_CHANGED_MESSAGE);
      }
      basket.push({ tier, quantity: line.quantity });
    }
    const refusal = buyRefusal(
      order.event,
      order.buyerWawuId,
      basket,
      new Date(),
    );
    if (refusal) throw refusal;
  }

  /** The host as the pay sheet names them; WAWU ID being slow never costs the payment. */
  private async host(hostWawuId: string): Promise<MoneyPartyView> {
    try {
      const parties = await loadMoneyParties(this.prisma, this.wawuId, [
        hostWawuId,
      ]);
      const party = parties.get(hostWawuId);
      if (party) return party;
    } catch {
      // A name is never worth a failed payment: the party reads from its id.
    }
    return {
      wawuUserId: hostWawuId,
      displayName: '',
      handle: null,
      avatarUrl: null,
      tick: null,
    };
  }

  // -------------------------------------------------------------------------
  // Delivery: the tickets, once the debit is confirmed
  // -------------------------------------------------------------------------

  /**
   * The payment is confirmed and its price is held. Issues the tickets once;
   * resolves when the order is settled either way. If the seats went since the
   * quote, or the event was called off, the order is `failed` and the hold is
   * refunded by itself. The hold is otherwise left alone: WALLET-17 releases
   * the host's share when the event takes place, EVENTS-10 refunds everyone
   * when it is called off.
   */
  private async onCompleted(payment: CompletedPayment): Promise<void> {
    const order = await this.prisma.eventOrder.findFirst({
      where: { id: payment.targetId, paymentProvider: 'wallet' },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      // The order is gone (the host replaced the tiers while a payment was
      // unconfirmed): nothing to give, so the price goes back.
      this.logger.error(
        `event order ${payment.targetId}: no such order to deliver; payment ${payment.paymentId} is refunded`,
      );
      await this.holds.refund(
        { paymentId: payment.paymentId },
        FAILED_REFUND_REASON,
        RETURN_ALL,
      );
      return;
    }
    if (
      order.walletPaymentId !== null &&
      order.walletPaymentId !== payment.paymentId
    ) {
      // Another payment paid this order: this one is a second payment for one
      // order, which the payment service already flags. No second set of
      // tickets; the money goes back.
      this.logger.error(
        `event order ${order.id}: payment ${payment.paymentId} completed for an order another payment paid; it is refunded`,
      );
      await this.holds.refund(
        { paymentId: payment.paymentId },
        FAILED_REFUND_REASON,
        RETURN_ALL,
      );
      return;
    }
    switch (order.status) {
      case 'paid':
        return;
      case 'failed':
      case 'refunded':
        await this.holds.refund(
          { paymentId: payment.paymentId },
          FAILED_REFUND_REASON,
          RETURN_ALL,
        );
        return;
      case 'pending':
        break;
    }

    let reason: string | null =
      order.event.cancelledAt !== null || order.event.status !== 'published'
        ? 'the event was called off'
        : null;
    if (reason === null) {
      try {
        if (await this.issue(order, payment)) {
          // EMAIL-02: once, by the delivery that issued the tickets.
          this.emailTicket(order, payment);
          return;
        }
        // Another delivery got to the order first. If it was this payment's,
        // the tickets exist; if not, this payment is one the order cannot use.
        const now = await this.prisma.eventOrder.findUnique({
          where: { id: order.id },
          select: { status: true, walletPaymentId: true },
        });
        if (
          now?.status === 'paid' &&
          now.walletPaymentId === payment.paymentId
        ) {
          return;
        }
        reason = 'the order was already settled another way';
      } catch (e) {
        if (e instanceof CalledOff) reason = 'the event was called off';
        else if (e instanceof SoldOut) reason = `${e.tierName} sold out`;
        else throw e;
      }
    }
    this.logger.warn(
      `event order ${order.id}: paid but not issued (${reason}); the payment is refunded`,
    );
    await this.prisma.eventOrder.updateMany({
      where: { id: order.id, status: 'pending' },
      data: {
        status: 'failed',
        failureReason: reason,
        walletPaymentId: payment.paymentId,
        holdId: payment.holdId,
      },
    });
    await this.holds.refund(
      { paymentId: payment.paymentId },
      FAILED_REFUND_REASON,
      RETURN_ALL,
    );
  }

  /** EMAIL-02: the buyer's "you are going" email, after the tickets are committed. */
  private emailTicket(order: OrderRow, payment: CompletedPayment): void {
    const { mail, facts } = this;
    if (!mail || !facts) return;
    mail.later(async () => {
      const paid = await facts.payment(payment.paymentId);
      if (!paid) return;
      mail.notify(
        order.buyerWawuId,
        'ticket_confirmed',
        {
          eventTitle: order.event.name,
          startsAt: order.event.startsAt.toISOString(),
          place: order.event.venueName ?? order.event.location ?? null,
          paidMinor: paid.totalKobo,
          currency: 'NGN',
          ticketRef: paid.reference,
        },
        noticeKey('ticket_confirmed', order.id),
      );
    });
  }

  /**
   * Claims the order and makes its tickets in one short transaction: the
   * conditional flip of `pending` to `paid` is the first statement, so a
   * second delivery waits for the first and then touches nothing (false). The
   * seats are taken in the same transaction; if they went, it rolls back
   * whole (the flip with it) and throws `SoldOut`.
   */
  private async issue(
    order: OrderRow,
    payment: CompletedPayment,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // EVENTS-10: a host's cancel updates the event row, so it waits for this
      // share lock (and this waits for it): either the cancel comes after and
      // voids these tickets and refunds this order, or it came first and no
      // ticket is made for a called-off event.
      await this.assertNotCalledOff(tx, order.eventId);
      const flipped = await tx.eventOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: {
          status: 'paid',
          paidAt: new Date(),
          walletPaymentId: payment.paymentId,
          holdId: payment.holdId,
        },
      });
      if (flipped.count === 0) return false;
      await this.takeSeats(
        tx,
        order.lines.map((l) => ({
          tier: { id: l.ticketTypeId, name: l.tierName },
          quantity: l.quantity,
        })),
      );
      await tx.eventTicket.createMany({
        data: order.lines.flatMap((l) =>
          Array.from({ length: l.quantity }, () => ({
            orderId: order.id,
            eventId: order.eventId,
            ticketTypeId: l.ticketTypeId,
            code: ticketCode(),
          })),
        ),
      });
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private async quoteOf(
    wallet: OpenWallet,
    order: OrderRow,
  ): Promise<EventWalletOrderQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: EVENT_TICKET_PAYMENT_KIND,
      targetId: order.id,
    });
    return { order: await this.viewOf(order), payment };
  }

  private async present(payment: PaymentView): Promise<EventWalletOrderView> {
    const order = await this.prisma.eventOrder.findUnique({
      where: { id: payment.targetId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw orderNotFound();
    return this.viewOf(order);
  }

  async viewOf(order: OrderRow): Promise<EventWalletOrderView> {
    const payment =
      order.paymentProvider === 'free'
        ? null
        : order.walletPaymentId
          ? await this.prisma.walletPayment.findUnique({
              where: { id: order.walletPaymentId },
            })
          : await this.prisma.walletPayment.findFirst({
              where: {
                kind: EVENT_TICKET_PAYMENT_KIND,
                targetId: order.id,
                payerWawuUserId: order.buyerWawuId,
                status: { in: ['pending', 'completed'] },
              },
              orderBy: { createdAt: 'desc' },
            });
    const status = progressOf(order.status, payment !== null);
    const paymentStatus =
      (payment?.status as PaymentStatus | undefined) ?? null;
    const lines = order.lines.map((l) => ({
      ticketTypeId: l.ticketTypeId,
      tierName: l.tierName,
      unitPriceKobo: l.unitPriceNaira * 100,
      quantity: l.quantity,
      lineKobo: l.unitPriceNaira * 100 * l.quantity,
    }));

    let returned: EventOrderReturnView | null = null;
    if (
      (order.status === 'failed' || order.status === 'refunded') &&
      order.walletPaymentId
    ) {
      // The hold's own row: what the move to the buyer was (the price, and the
      // payment's charge too when the order failed after the debit).
      const hold = await this.prisma.walletHold.findUnique({
        where: { paymentId: order.walletPaymentId },
        select: { status: true, refundedKobo: true, transferKobo: true },
      });
      if (hold) {
        const back = hold.status === 'refunded';
        returned = {
          holdStatus: hold.status as HoldStatus,
          returned: back,
          returnedKobo: back
            ? koboNumber(hold.transferKobo ?? hold.refundedKobo ?? 0n)
            : null,
        };
      }
    }

    const tickets =
      order.status === 'paid'
        ? (
            await this.prisma.eventTicket.findMany({
              where: { orderId: order.id },
              select: {
                id: true,
                code: true,
                status: true,
                ticketType: { select: { name: true } },
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            })
          ).map((t) => ({
            id: t.id,
            code: t.code,
            tierName: t.ticketType.name,
            status: t.status,
          }))
        : [];

    return {
      id: order.id,
      reference: order.paymentReference ?? '',
      event: {
        id: order.event.id,
        name: order.event.name,
        startsAt: order.event.startsAt.toISOString(),
        endsAt: order.event.endsAt?.toISOString() ?? null,
        timezone: order.event.timezone,
        timeLabel: order.event.timeLabel,
        location: order.event.location,
        venueName: order.event.venueName,
        bannerUrl: order.event.bannerUrl,
        cancelledAt: order.event.cancelledAt?.toISOString() ?? null,
      },
      free: order.paymentProvider === 'free',
      lines,
      ticketCount: lines.reduce((n, l) => n + l.quantity, 0),
      ticketsKobo: order.amountNaira * 100,
      status,
      paymentId: payment?.id ?? null,
      paymentStatus,
      statusMessage:
        status !== 'processing'
          ? null
          : paymentStatus === 'completed'
            ? FINISHING_MESSAGE
            : STILL_CONFIRMING_MESSAGE,
      transferFeeKobo:
        payment && payment.status === 'completed'
          ? koboNumber(payment.providerFeeKobo)
          : null,
      totalKobo:
        payment && payment.status === 'completed'
          ? koboNumber(payment.totalKobo)
          : null,
      holderName:
        order.status === 'paid' ? await this.holder(order.buyerWawuId) : null,
      tickets,
      failureReason:
        order.status === 'failed'
          ? returned?.returned
            ? ORDER_FAILED_RETURNED_REASON
            : ORDER_FAILED_RETURNING_REASON
          : order.status === 'refunded'
            ? returned?.returned
              ? ORDER_REFUNDED_RETURNED_REASON
              : ORDER_REFUNDED_RETURNING_REASON
            : null,
      returned,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
    };
  }

  /** The name on the tickets (E5); WAWU ID being slow leaves it null, never fails the answer. */
  private async holder(buyerWawuId: string): Promise<string | null> {
    try {
      const identity = (
        await this.wawuId.lookupPublicIdentities([buyerWawuId])
      ).get(buyerWawuId);
      return (
        [identity?.firstName, identity?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() || null
      );
    } catch {
      return null;
    }
  }
}
