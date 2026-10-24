import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionCapitalHandler } from '../handlers/capital.handler';
import type { NuvionDelivery } from '../handlers/nuvion-handler.interface';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';

/**
 * NUV-12's webhook handler on a real database: a `capital-*` payout or
 * purchase reaches the ledger through the order's own writer once, an order
 * event only wakes a read, and anything that is not Capital's is left alone.
 * The Capital service is a fake that records what it was asked; the
 * transfer shapes are the ones Nuvion's dev gave on 24 Oct 2026.
 */

const ENTITY = `01N12ENT${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
const USER_CAP = `01N12UCA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
const NUVION_ORDER = `01N12ORD${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;

function delivery(event: string, data: unknown, attempts = 1): NuvionDelivery {
  return {
    id: randomUUID(),
    eventId: randomUUID(),
    event,
    resourceId: null,
    entityId: ENTITY,
    data,
    receivedAt: new Date(),
    attempts,
  };
}

const transfer = (over: Record<string, unknown>) => ({
  id: `01N12TRF${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`,
  amount: 5000,
  currency: 'NGN',
  unique_reference: '01M5PY13442N1EMED63QB4J3GF',
  counterparty_id: USER_CAP,
  account_id: '01N12ACCOUNT0000000000000A',
  entity_id: ENTITY,
  status: 'successful',
  narration: '90 Days Treasury Bills liquidation payout',
  type: 'inflow',
  payment_type: 'capital-early-liquidation-withdrawal',
  applicable_fee: 0,
  created: 1792844795013,
  ...over,
});

describe('NUV-12: the Capital webhook handler', () => {
  let prisma: PrismaService;
  let handler: NuvionCapitalHandler;
  const user = randomUUID();
  const calls = {
    refresh: [] as string[],
    payout: [] as Array<{ transferId: string; amountKobo: number }>,
    purchase: [] as Array<string | null>,
  };
  let running: unknown;
  let orderId = '';

  beforeAll(async () => {
    const provider = Object.create(
      NuvionWalletProvider.prototype,
    ) as NuvionWalletProvider;
    running = provider;
    const capital = {
      walletOf: () =>
        Promise.resolve({
          wawuUserId: user,
          walletId: 'w',
          accountNumber: '8400000001',
        }),
      refresh: (_w: unknown, row: { id: string }) => {
        calls.refresh.push(row.id);
        return Promise.resolve(row);
      },
      ledger: {
        recordPayout: (
          _row: unknown,
          _n: string,
          d: { transferId: string; amountKobo: number },
        ) => {
          calls.payout.push(d);
          return Promise.resolve(true);
        },
        recordPurchase: (_row: unknown, _n: string, id: string | null) => {
          calls.purchase.push(id);
          return Promise.resolve();
        },
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [NuvionCapitalHandler],
    })
      .overrideProvider(NuvionCapitalHandler)
      .useFactory({
        factory: (db: PrismaService) =>
          new NuvionCapitalHandler(db, {
            get: (token: unknown) =>
              token === WALLET_PROVIDER ? running : capital,
          } as never),
        inject: [PrismaService],
      })
      .compile();
    prisma = moduleRef.get(PrismaService);
    handler = moduleRef.get(NuvionCapitalHandler);
    await prisma.nuvionEntity.create({
      data: { wawuUserId: user, entityId: ENTITY, status: 'approved' },
    });
    const row = await prisma.capitalOrder.create({
      data: {
        wawuUserId: user,
        reserveKey: randomUUID(),
        fingerprint: 'x',
        state: 'confirmed',
        nuvionOrderId: NUVION_ORDER,
        productId: '01N12PRODUCT00000000000001',
        productName: '90 Days Treasury Bills',
        productType: 'FIXED_RETURN',
        currency: 'NGN',
        amountMinor: 5000n,
        totalDebitMinor: 5000n,
        userCapitalAccountId: USER_CAP,
      },
    });
    orderId = row.id;
  });

  afterAll(async () => {
    await prisma.capitalOrder.deleteMany({ where: { wawuUserId: user } });
    await prisma.nuvionEntity.deleteMany({ where: { wawuUserId: user } });
  });

  it('writes a payout to the ledger once the order is matched by its holding, and keeps the transfer id', async () => {
    const t = transfer({});
    const r = await handler.handle(delivery('inflows.completed', t));
    expect(r.outcome).toBe('done');
    expect(calls.payout).toEqual([
      {
        transferId: t.id,
        uniqueReference: t.unique_reference,
        amountKobo: 5000,
        at: expect.any(Date) as Date,
      },
    ]);
    expect(calls.refresh).toContain(orderId);
    const row = await prisma.capitalOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(row.payoutTransferId).toBe(t.id);
  });

  it('matches a purchase to the one order of that amount, and does not guess between two', async () => {
    const t = transfer({
      type: 'outflow',
      payment_type: 'capital-fixed-return-purchase',
      counterparty_id: '01N12OWNER00000000000000AA',
    });
    const r = await handler.handle(delivery('outflows.completed', t));
    expect(r.outcome).toBe('done');
    expect(calls.purchase).toEqual([t.id]);

    const second = await prisma.capitalOrder.create({
      data: {
        wawuUserId: user,
        reserveKey: randomUUID(),
        fingerprint: 'y',
        state: 'confirmed',
        nuvionOrderId: `${NUVION_ORDER.slice(0, 20)}BB`,
        productId: '01N12PRODUCT00000000000001',
        productName: 'Other',
        productType: 'FIXED_RETURN',
        currency: 'NGN',
        amountMinor: 7000n,
        totalDebitMinor: 7000n,
      },
    });
    await prisma.capitalOrder.create({
      data: {
        wawuUserId: user,
        reserveKey: randomUUID(),
        fingerprint: 'z',
        state: 'confirmed',
        nuvionOrderId: `${NUVION_ORDER.slice(0, 20)}CC`,
        productId: '01N12PRODUCT00000000000001',
        productName: 'Other',
        productType: 'FIXED_RETURN',
        currency: 'NGN',
        amountMinor: 7000n,
        totalDebitMinor: 7000n,
      },
    });
    const before = calls.purchase.length;
    const two = await handler.handle(
      delivery(
        'outflows.completed',
        transfer({
          type: 'outflow',
          payment_type: 'capital-fixed-return-purchase',
          amount: 7000,
        }),
      ),
    );
    expect(two.outcome).toBe('done');
    expect(calls.purchase).toHaveLength(before);
    expect(second.id).not.toBe('');
  });

  it('waits for an order it cannot match yet, then leaves it for review', async () => {
    const t = transfer({ counterparty_id: '01N12NOBODY00000000000000A' });
    expect(
      (await handler.handle(delivery('inflows.completed', t, 1))).outcome,
    ).toBe('wait');
    expect(
      (await handler.handle(delivery('inflows.completed', t, 6))).outcome,
    ).toBe('failed');
  });

  it('leaves another rail alone and a failed transfer unwritten', async () => {
    const book = await handler.handle(
      delivery(
        'inflows.completed',
        transfer({ payment_type: 'book-transfer' }),
      ),
    );
    expect(book).toMatchObject({
      outcome: 'done',
      note: 'not a Capital transfer',
    });
    const failed = await handler.handle(
      delivery('inflows.completed', transfer({ status: 'failed' })),
    );
    expect(failed.outcome).toBe('done');
    expect(calls.payout).toHaveLength(1);
  });

  it('an order event only wakes a read of that order; one that is not ours is left alone', async () => {
    const before = calls.refresh.length;
    const r = await handler.handle(
      delivery('capital_orders.completed', {
        id: NUVION_ORDER,
        status: 'APPROVED',
      }),
    );
    expect(r.outcome).toBe('done');
    expect(calls.refresh).toHaveLength(before + 1);
    const other = await handler.handle(
      delivery('capital_accounts.updated', {
        id: 'x',
        capital_order_id: '01N12STRANGER000000000000AA',
      }),
    );
    expect(other.outcome).toBe('done');
    expect(calls.refresh).toHaveLength(before + 1);
  });

  it('a server running another provider leaves the delivery for a Nuvion server', async () => {
    const was = running;
    running = { label: 'Fintava' };
    try {
      const r = await handler.handle(
        delivery('capital_orders.completed', { id: NUVION_ORDER }),
      );
      expect(r.outcome).toBe('wait');
    } finally {
      running = was;
    }
  });
});
