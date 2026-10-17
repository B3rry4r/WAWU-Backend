import {
  type BuyableEvent,
  type BuyableTier,
  buyRefusal,
  distinctLines,
  KEY_PATTERN,
  newOrderReference,
  overOrderLimit,
  progressOf,
  ticketCountOf,
  totalNairaOf,
  walletOrderTxRef,
} from '../wallet/event-wallet-order-rules';

const now = new Date('2026-10-20T10:00:00Z');
const event: BuyableEvent = {
  hostWawuId: 'host',
  status: 'published',
  cancelledAt: null,
  startsAt: new Date('2026-11-01T10:00:00Z'),
};
const tier = (over: Partial<BuyableTier> = {}): BuyableTier => ({
  name: 'Regular',
  priceNaira: 7_500,
  quantity: 10,
  sold: 0,
  salesStartAt: null,
  salesEndAt: null,
  ...over,
});
const refusal = (
  basket: Array<{ tier: BuyableTier; quantity: number }>,
  ev = event,
  buyer = 'buyer',
) => buyRefusal(ev, buyer, basket, now)?.getResponse();
const message = (r: unknown) =>
  (r as { reason: { message: string } } | undefined)?.reason.message;

describe('EVENTS-07 order rules', () => {
  it('totals a basket in naira and counts its tickets', () => {
    expect(
      totalNairaOf([
        { priceNaira: 7_500, quantity: 2 },
        { priceNaira: 20_000, quantity: 1 },
        { priceNaira: 0, quantity: 3 },
      ]),
    ).toBe(35_000);
    expect(
      ticketCountOf([
        { ticketTypeId: 'a', quantity: 2 },
        { ticketTypeId: 'b', quantity: 4 },
      ]),
    ).toBe(6);
    expect(overOrderLimit([{ ticketTypeId: 'a', quantity: 50 }])).toBe(false);
    expect(
      overOrderLimit([
        { ticketTypeId: 'a', quantity: 50 },
        { ticketTypeId: 'b', quantity: 1 },
      ]),
    ).toBe(true);
  });

  it('takes one line per ticket type', () => {
    expect(
      distinctLines([
        { ticketTypeId: 'a', quantity: 1 },
        { ticketTypeId: 'b', quantity: 1 },
      ]),
    ).toHaveLength(2);
    expect(
      distinctLines([
        { ticketTypeId: 'a', quantity: 1 },
        { ticketTypeId: 'a', quantity: 2 },
      ]),
    ).toBeNull();
  });

  it('lets a basket through only while every line can be bought', () => {
    expect(refusal([{ tier: tier(), quantity: 2 }])).toBeUndefined();
    expect(
      message(
        refusal([{ tier: tier(), quantity: 2 }], {
          ...event,
          cancelledAt: now,
        }),
      ),
    ).toBe('This event has been cancelled.');
    expect(
      message(
        refusal([{ tier: tier(), quantity: 2 }], {
          ...event,
          status: 'pending',
        }),
      ),
    ).toBe('Tickets are not on sale for this event.');
    expect(
      message(refusal([{ tier: tier(), quantity: 1 }], event, 'host')),
    ).toBe('You cannot buy tickets to your own event.');
    expect(message(refusal([{ tier: tier({ sold: 10 }), quantity: 1 }]))).toBe(
      'Regular is sold out.',
    );
    expect(message(refusal([{ tier: tier({ sold: 8 }), quantity: 3 }]))).toBe(
      'Only 2 of Regular left.',
    );
    expect(
      message(
        refusal([
          {
            tier: tier({ salesStartAt: new Date('2026-10-25T00:00:00Z') }),
            quantity: 1,
          },
        ]),
      ),
    ).toBe('Sales have not opened for Regular yet.');
    expect(
      message(
        refusal([
          {
            tier: tier({ salesEndAt: new Date('2026-10-19T00:00:00Z') }),
            quantity: 1,
          },
        ]),
      ),
    ).toBe('Sales have closed for Regular.');
    // With no end of its own, a tier sells until the event starts.
    expect(
      message(
        refusal([{ tier: tier(), quantity: 1 }], {
          ...event,
          startsAt: new Date('2026-10-19T00:00:00Z'),
        }),
      ),
    ).toBe('Sales have closed for Regular.');
  });

  it('reads where an order stands from its status and whether a payment exists', () => {
    expect(progressOf('pending', false)).toBe('awaiting_payment');
    expect(progressOf('pending', true)).toBe('processing');
    expect(progressOf('paid', true)).toBe('paid');
    expect(progressOf('paid', false)).toBe('paid');
    expect(progressOf('failed', true)).toBe('failed');
    expect(progressOf('refunded', true)).toBe('failed');
  });

  it('makes a reference a person can quote, and a transaction reference no Flutterwave charge can carry', () => {
    const seen = new Set(Array.from({ length: 200 }, newOrderReference));
    expect(seen.size).toBeGreaterThan(190);
    for (const ref of seen) expect(ref).toMatch(/^WAW-EVT-[A-HJ-NP-Z2-9]{8}$/);
    expect(walletOrderTxRef('abc')).toBe('wawu-event-wallet-abc');
    expect(KEY_PATTERN.test('abcd1234')).toBe(true);
    expect(KEY_PATTERN.test('short')).toBe(false);
    expect(KEY_PATTERN.test('has space in it')).toBe(false);
  });
});
