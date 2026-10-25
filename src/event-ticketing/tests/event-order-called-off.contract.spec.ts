import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EventWalletOrderService } from '../wallet/event-wallet-order.service';

/**
 * R2-SOCIAL fix round 2 (E11): the order page of a called-off event.
 *
 * Once the host calls an event off, `GET /events/{id}` answers the buyer 404
 * (an event that is not live is an event you are not told about), so the app
 * cannot learn from that route that the event was called off. The buyer's own
 * order read already joins the event, so it carries the call-off time in the
 * event block: `event.cancelledAt`, an ISO time, or null while the event is
 * on. Additive: a new nullable field; nothing the web or the dashboard calls
 * changes.
 *
 * It needs no wallet provider: the rows (event, order, line, payment, hold,
 * tickets) are written straight into the database, and the wallet order
 * service is built with the pieces that talk to a provider replaced by plain
 * stubs, as the EVENTS-11 wallet-orders spec does. Fixture ids `0fc0ff..`.
 */

const HOST = randomUUID();
const BUYER = randomUUID();
const LIVE = '0fc0ff00-0000-4000-8000-000000000001';
const CALLED_OFF = '0fc0ff00-0000-4000-8000-000000000002';
const CALLED_OFF_AT = new Date('2027-04-01T08:30:00.000Z');

describe('the order read of a called-off event (R2-SOCIAL fix round 2, E11)', () => {
  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let wallet: EventWalletOrderService;

  async function sweep(): Promise<void> {
    await prisma.walletHold.deleteMany({
      where: { kind: 'event_ticket', title: 'ec0ff fixture' },
    });
    await prisma.walletPayment.deleteMany({
      where: { kind: 'event_ticket', title: 'ec0ff fixture' },
    });
    // Orders, lines, tickets and tiers cascade from Event.
    await prisma.event.deleteMany({
      where: { id: { in: [LIVE, CALLED_OFF] } },
    });
  }

  async function seedEvent(id: string, calledOff: boolean): Promise<string> {
    await prisma.event.create({
      data: {
        id,
        hostWawuId: HOST,
        name: calledOff ? 'EC0FF called off' : 'EC0FF on',
        description: 'A fixture for the called-off order read.',
        hostOrg: 'EC0FF Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: new Date('2027-05-06T09:00:00.000Z'),
        status: calledOff ? 'cancelled' : 'published',
        ...(calledOff
          ? { cancelledAt: CALLED_OFF_AT, cancelReason: 'The venue is gone.' }
          : {}),
        ticketTypes: {
          create: [
            {
              tier: 'regular',
              name: 'Regular',
              priceNaira: 7500,
              quantity: 100,
            },
          ],
        },
      },
    });
    const tier = await prisma.eventTicketType.findFirstOrThrow({
      where: { eventId: id },
    });
    return tier.id;
  }

  /**
   * A wallet order for one Regular ticket (7,500 naira), written as the Hub
   * leaves one: `failed` with its price back in the wallet, or `paid` with
   * its ticket voided by the call-off.
   */
  async function seedOrder(
    eventId: string,
    tierId: string,
    kind: 'failed' | 'paid-void' | 'paid-valid',
  ): Promise<string> {
    const id = randomUUID();
    const kobo = BigInt(7500 * 100);
    const payment = await prisma.walletPayment.create({
      data: {
        kind: 'event_ticket',
        targetId: id,
        title: 'ec0ff fixture',
        priceKobo: kobo,
        providerFeeKobo: BigInt(0),
        wawuFeeKobo: BigInt(0),
        totalKobo: kobo,
        payeeShareKobo: BigInt(0),
        wawuShareKobo: BigInt(0),
        customerReference: `ec0ff-${id}`,
        merchantAccountNumber: '0000000000',
        status: 'completed',
      },
    });
    const refunded = kind === 'failed';
    await prisma.walletHold.create({
      data: {
        paymentId: payment.id,
        kind: 'event_ticket',
        targetId: id,
        title: 'ec0ff fixture',
        releaseCondition: 'event_takes_place',
        amountKobo: kobo,
        payeeShareKobo: kobo,
        wawuShareKobo: BigInt(0),
        merchantAccountNumber: '0000000000',
        status: refunded ? 'refunded' : 'held',
        heldAt: new Date(),
        ...(refunded
          ? {
              settledAt: new Date(),
              action: 'refund',
              actionAt: new Date(),
              refundedKobo: kobo,
            }
          : {}),
      },
    });
    await prisma.eventOrder.create({
      data: {
        id,
        eventId,
        ticketTypeId: tierId,
        buyerWawuId: BUYER,
        quantity: 1,
        amountNaira: 7500,
        commissionRate: 0.15,
        status: refunded ? 'failed' : 'paid',
        flutterwaveTxRef: `wawu-event-wallet-${id}`,
        paymentProvider: 'wallet',
        paymentReference: `WAW-EVT-${id.slice(0, 8)}`,
        walletPaymentId: payment.id,
        paidAt: new Date(),
        ...(refunded ? { failureReason: 'The event was called off.' } : {}),
        lines: {
          create: [
            {
              ticketTypeId: tierId,
              tierName: 'Regular',
              unitPriceNaira: 7500,
              quantity: 1,
            },
          ],
        },
      },
    });
    if (!refunded) {
      await prisma.eventTicket.create({
        data: {
          orderId: id,
          eventId,
          ticketTypeId: tierId,
          code: `EC0F-${id.slice(0, 8)}`,
          status: kind === 'paid-void' ? 'void' : 'valid',
        },
      });
    }
    return id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    // Everything that would reach a wallet provider is a stub; the read
    // touches our own rows only.
    wallet = new EventWalletOrderService(
      prisma,
      {} as never,
      { register: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { number: () => 5 } as never,
    );
    await sweep();
  }, 60_000);

  afterAll(async () => {
    await sweep();
    await moduleRef.close();
  });

  it('a failed order of a called-off event carries the time the host called it off', async () => {
    const tier = await seedEvent(CALLED_OFF, true);
    const orderId = await seedOrder(CALLED_OFF, tier, 'failed');
    const order = await wallet.read(BUYER, orderId);
    expect(order.status).toBe('failed');
    expect(order.returned?.returned).toBe(true);
    expect(order.event.cancelledAt).toBe(CALLED_OFF_AT.toISOString());
  });

  it('a paid order whose ticket the call-off voided carries it too', async () => {
    const [tier] = await prisma.eventTicketType.findMany({
      where: { eventId: CALLED_OFF },
    });
    const orderId = await seedOrder(CALLED_OFF, tier.id, 'paid-void');
    const order = await wallet.read(BUYER, orderId);
    expect(order.status).toBe('paid');
    expect(order.tickets.map((t) => t.status)).toEqual(['void']);
    expect(order.event.cancelledAt).toBe(CALLED_OFF_AT.toISOString());
  });

  it('an order of an event that is still on carries null', async () => {
    const tier = await seedEvent(LIVE, false);
    const orderId = await seedOrder(LIVE, tier, 'paid-valid');
    const order = await wallet.read(BUYER, orderId);
    expect(order.status).toBe('paid');
    expect(order.event.cancelledAt).toBeNull();
  });

  it('it is still only the buyer who reads the order', async () => {
    const [row] = await prisma.eventOrder.findMany({
      where: { eventId: CALLED_OFF },
      take: 1,
    });
    await expect(wallet.read(randomUUID(), row.id)).rejects.toBeDefined();
  });
});
