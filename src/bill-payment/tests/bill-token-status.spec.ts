import { NotFoundException } from '@nestjs/common';
import { BillPaymentService } from '../bill-payment.service';
import type { FlutterwaveBillsClient } from '../flutterwave-bills.client';
import type { FlutterwaveCheckoutVerifier } from '../../common/flutterwave/checkout-verifier';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type {
  AdminActor,
  AdminOpsAuditService,
} from '../../common/audit/admin-ops-audit.service';
import { AdminRole } from '../../../generated/prisma/enums';

/**
 * BILLS-09 (R-102): a prepaid electricity bill is useless without its token.
 *
 * The token and the units are read from Flutterwave's answer to the purchase and to the bill status read, kept on the
 * bill, and served to the buyer only (verify, mine and the new status read). The buyer's status read asks Flutterwave
 * for a `processing` bill at most once in 20 seconds, however many reads arrive, and settles it the way the sweep does.
 */

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  createdAt: Date;
};

const TOKEN = '4821 0937 5510 2286 7734';

/** An in-memory BillPayment table that honours the conditions the service writes with. */
function buildPrisma(rows: Row[]) {
  const store = new Map<string, Row>(rows.map((r) => [r.id, { ...r }]));

  type Where = {
    id?: string;
    status?: string;
    OR?: { providerCheckedAt?: null | { lt: Date } }[];
  };

  function matches(row: Row, where: Where): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.OR) {
      const checked = row.providerCheckedAt as Date | null | undefined;
      const ok = where.OR.some((clause) => {
        if (clause.providerCheckedAt === null) return checked == null;
        if (clause.providerCheckedAt) {
          return checked != null && checked < clause.providerCheckedAt.lt;
        }
        return true;
      });
      if (!ok) return false;
    }
    return true;
  }

  const prisma = {
    billPayment: {
      findUnique: ({ where }: { where: { id: string } }) => {
        const row = store.get(where.id);
        return Promise.resolve(row ? { ...row } : null);
      },
      updateMany: ({
        where,
        data,
      }: {
        where: Where;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of store.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = store.get(where.id);
        if (!row) throw new Error(`no such row ${where.id}`);
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
      findMany: () =>
        Promise.resolve([...store.values()].map((r) => ({ ...r }))),
    },
  } as unknown as PrismaService;

  return { prisma, store };
}

interface Options {
  payBill?: unknown;
  billStatus?: unknown;
  statusDelayMs?: number;
}

function build(rows: Row[], options: Options = {}) {
  const { prisma, store } = buildPrisma(rows);
  const billStatus = jest.fn(async () => {
    if (options.statusDelayMs)
      await new Promise((r) => setTimeout(r, options.statusDelayMs));
    if (typeof options.billStatus === 'function')
      return (options.billStatus as () => Promise<unknown>)();
    return options.billStatus ?? {};
  });
  const payBill = jest.fn(() =>
    Promise.resolve(
      options.payBill ?? { reference: 'FLW-REF-1', code: '00', fee: 10 },
    ),
  );
  const bills = { payBill, billStatus } as unknown as FlutterwaveBillsClient;
  const verifier = {
    verify: () => Promise.resolve({ transactionId: 'flw-txn-1' }),
  } as unknown as FlutterwaveCheckoutVerifier;
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AdminOpsAuditService;
  const service = new BillPaymentService(prisma, bills, verifier, audit);
  return { service, store, billStatus, payBill };
}

const ADMIN: AdminActor = {
  id: 'admin-1',
  email: 'finance@wawu.dev',
  role: AdminRole.finance,
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'bill-1',
    buyerWawuId: 'buyer-1',
    category: 'POWER',
    billerCode: 'BIL112',
    itemCode: 'UB159',
    billerName: 'IKEDC PREPAID',
    customerRef: '45021234567',
    amount: 5000,
    fee: 0,
    flutterwaveTxRef: 'wawu-bill-x',
    flutterwaveTxId: null,
    providerReference: null,
    providerStatus: null,
    failureReason: null,
    token: null,
    units: null,
    providerCheckedAt: null,
    status: 'pending',
    createdAt: new Date(),
    deliveredAt: null,
    refundReference: null,
    refundedAt: null,
    ...overrides,
  };
}

const SECONDS = 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('BILLS-09: the token and the units from the purchase answer', () => {
  it('keeps them and serves them to the buyer when verify delivers a prepaid bill', async () => {
    const { service, store } = build([row()], {
      payBill: {
        reference: 'FLW-REF-1',
        code: '00',
        fee: 0,
        recharge_token: TOKEN,
        extra: 'Units: 45.2',
      },
    });

    const result = await service.verifyAndDeliver(
      'buyer-1',
      'bill-1',
      'flw-txn-1',
    );

    expect(result.status).toBe('processing');
    expect(result.token).toBe(TOKEN);
    expect(result.units).toBe('45.2');
    expect(store.get('bill-1')?.token).toBe(TOKEN);
    expect(store.get('bill-1')?.units).toBe('45.2');
    // The purchase counts as the first look at the provider, so a status read right after it asks nobody.
    expect(store.get('bill-1')?.providerCheckedAt).toBeInstanceOf(Date);
  });

  it('answers token and units as null (the key is there) when the purchase carries none', async () => {
    const { service } = build([row({ category: 'AIRTIME' })], {
      payBill: {
        reference: 'FLW-REF-1',
        code: '00',
        fee: 10,
        recharge_token: null,
        batch_reference: null,
      },
    });

    const result = await service.verifyAndDeliver(
      'buyer-1',
      'bill-1',
      'flw-txn-1',
    );

    expect(result).toHaveProperty('token', null);
    expect(result).toHaveProperty('units', null);
    // What it answered before BILLS-09 is all still there.
    expect(result).toEqual(
      expect.objectContaining({
        id: 'bill-1',
        category: 'AIRTIME',
        billerName: 'IKEDC PREPAID',
        customerRef: '45021234567',
        amount: 5000,
        fee: 10,
        status: 'processing',
        providerReference: 'FLW-REF-1',
        failureReason: null,
        deliveredAt: null,
        refundReference: null,
        refundedAt: null,
      }),
    );
  });

  it('serves the token on a second verify of the same bill, without paying the biller again', async () => {
    const { service, payBill } = build([row()], {
      payBill: { reference: 'R', code: '00', recharge_token: TOKEN },
    });
    await service.verifyAndDeliver('buyer-1', 'bill-1', 'flw-txn-1');
    const again = await service.verifyAndDeliver(
      'buyer-1',
      'bill-1',
      'flw-txn-1',
    );
    expect(again.token).toBe(TOKEN);
    expect(payBill).toHaveBeenCalledTimes(1);
  });
});

describe('BILLS-09: the token and the units from the bill status answer', () => {
  it('the sweep settles a processing bill and keeps the token and units the status read carries', async () => {
    const { service, store } = build(
      [row({ status: 'processing', createdAt: ago(60 * 60_000) })],
      {
        billStatus: {
          status: 'successful',
          token: TOKEN,
          extra: 'Units: 45.2',
        },
      },
    );

    await service.reconcilePendingDeliveries();

    expect(store.get('bill-1')?.status).toBe('delivered');
    expect(store.get('bill-1')?.token).toBe(TOKEN);
    expect(store.get('bill-1')?.units).toBe('45.2');
  });

  it("an operator's reconcile keeps them too, and its answer never carries them", async () => {
    const { service, store } = build([row({ status: 'processing' })], {
      billStatus: { status: 'successful', token: TOKEN },
    });

    const out = await service.reconcile('bill-1', ADMIN);

    expect(store.get('bill-1')?.token).toBe(TOKEN);
    expect(out.billPayment).not.toHaveProperty('token');
    expect(out.billPayment).not.toHaveProperty('units');
  });

  it("never reaches the operators' stuck list", async () => {
    const { service } = build([
      row({ status: 'failed', token: TOKEN, units: '45.2' }),
    ]);
    const stuck = await service.listStuck();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).not.toHaveProperty('token');
    expect(stuck[0]).not.toHaveProperty('units');
  });

  it('a token already kept is not replaced by a later answer, or by an answer without one', async () => {
    const { service, store } = build(
      [
        row({
          status: 'processing',
          token: TOKEN,
          units: '45.2',
          createdAt: ago(60 * 60_000),
        }),
      ],
      {
        billStatus: { status: 'successful', token: '1111 2222 3333 4444 5555' },
      },
    );
    await service.reconcilePendingDeliveries();
    expect(store.get('bill-1')?.token).toBe(TOKEN);
    expect(store.get('bill-1')?.units).toBe('45.2');
  });
});

describe('BILLS-09: GET /bills/:id/status', () => {
  it("another person's bill is not found, and the provider is not asked", async () => {
    const { service, billStatus } = build([
      row({ status: 'processing', providerCheckedAt: ago(5 * 60_000) }),
    ]);
    await expect(
      service.statusOf('someone-else', 'bill-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(billStatus).not.toHaveBeenCalled();
  });

  it('a bill that does not exist is not found', async () => {
    const { service } = build([]);
    await expect(service.statusOf('buyer-1', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers exactly status, token, units and providerReference (and the id)', async () => {
    const { service } = build([
      row({
        status: 'delivered',
        token: TOKEN,
        units: '45.2',
        providerReference: 'FLW-REF-1',
      }),
    ]);
    expect(await service.statusOf('buyer-1', 'bill-1')).toEqual({
      id: 'bill-1',
      status: 'delivered',
      token: TOKEN,
      units: '45.2',
      providerReference: 'FLW-REF-1',
    });
  });

  it.each(['pending', 'paid', 'delivered', 'failed', 'refunded'])(
    'a %s bill is read from the record and the provider is not asked',
    async (status) => {
      const { service, billStatus } = build([row({ status })]);
      const out = await service.statusOf('buyer-1', 'bill-1');
      expect(out.status).toBe(status);
      expect(billStatus).not.toHaveBeenCalled();
    },
  );

  it('a processing bill checked less than 20 seconds ago is read from the record only', async () => {
    const { service, billStatus } = build(
      [row({ status: 'processing', providerCheckedAt: ago(5 * SECONDS) })],
      { billStatus: { status: 'successful', token: TOKEN } },
    );
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out.status).toBe('processing');
    expect(out.token).toBeNull();
    expect(billStatus).not.toHaveBeenCalled();
  });

  it('a processing bill checked more than 20 seconds ago asks the provider once and settles', async () => {
    const { service, store, billStatus } = build(
      [
        row({
          status: 'processing',
          providerReference: 'FLW-REF-1',
          providerCheckedAt: ago(21 * SECONDS),
        }),
      ],
      {
        billStatus: {
          status: 'successful',
          token: TOKEN,
          extra: 'Units: 45.2',
        },
      },
    );

    const out = await service.statusOf('buyer-1', 'bill-1');

    expect(billStatus).toHaveBeenCalledTimes(1);
    expect(billStatus).toHaveBeenCalledWith('wawu-bill-x');
    expect(out).toEqual({
      id: 'bill-1',
      status: 'delivered',
      token: TOKEN,
      units: '45.2',
      providerReference: 'FLW-REF-1',
    });
    expect(store.get('bill-1')?.deliveredAt).toBeInstanceOf(Date);
  });

  it('a processing bill never checked (before BILLS-09) is checked', async () => {
    const { service, billStatus } = build([row({ status: 'processing' })], {
      billStatus: { status: 'successful' },
    });
    expect((await service.statusOf('buyer-1', 'bill-1')).status).toBe(
      'delivered',
    );
    expect(billStatus).toHaveBeenCalledTimes(1);
  });

  it('a provider that says failed settles the bill as failed and never buys again', async () => {
    const { service, store, payBill } = build(
      [row({ status: 'processing', providerCheckedAt: ago(30 * SECONDS) })],
      { billStatus: { status: 'failed' } },
    );
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out.status).toBe('failed');
    expect(store.get('bill-1')?.failureReason).toBeTruthy();
    expect(payBill).not.toHaveBeenCalled();
  });

  it('a provider still in flight leaves it processing, and the next read within 20 seconds asks nobody', async () => {
    const { service, billStatus } = build(
      [row({ status: 'processing', providerCheckedAt: ago(30 * SECONDS) })],
      { billStatus: { status: 'pending' } },
    );
    expect((await service.statusOf('buyer-1', 'bill-1')).status).toBe(
      'processing',
    );
    expect((await service.statusOf('buyer-1', 'bill-1')).status).toBe(
      'processing',
    );
    expect(billStatus).toHaveBeenCalledTimes(1);
  });

  it('a token that arrives before the provider says successful is kept, and the bill stays processing', async () => {
    const { service } = build(
      [row({ status: 'processing', providerCheckedAt: ago(30 * SECONDS) })],
      { billStatus: { status: 'pending', token: TOKEN } },
    );
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out.status).toBe('processing');
    expect(out.token).toBe(TOKEN);
  });

  it('a provider that cannot be reached is not an error for the buyer: the record is answered', async () => {
    const { service, store } = build(
      [row({ status: 'processing', providerCheckedAt: ago(30 * SECONDS) })],
      {
        billStatus: () =>
          Promise.reject(
            new Error('Could not reach the bill payment provider.'),
          ),
      },
    );
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out.status).toBe('processing');
    expect(store.get('bill-1')?.status).toBe('processing');
  });

  it('two reads at once ask the provider once and settle the bill once', async () => {
    const { service, store, billStatus } = build(
      [row({ status: 'processing', providerCheckedAt: ago(60 * SECONDS) })],
      { billStatus: { status: 'successful', token: TOKEN }, statusDelayMs: 20 },
    );

    const reads = await Promise.all([
      service.statusOf('buyer-1', 'bill-1'),
      service.statusOf('buyer-1', 'bill-1'),
      service.statusOf('buyer-1', 'bill-1'),
    ]);

    expect(billStatus).toHaveBeenCalledTimes(1);
    expect(store.get('bill-1')?.status).toBe('delivered');
    // Every reader gets an honest answer: the claimed read settled it, the others saw it still processing or settled.
    for (const r of reads)
      expect(['processing', 'delivered']).toContain(r.status);
    expect(
      reads.filter((r) => r.status === 'delivered').length,
    ).toBeGreaterThanOrEqual(1);
    // A read after they all finished sees the settled bill with its token, without asking again.
    const after = await service.statusOf('buyer-1', 'bill-1');
    expect(after).toEqual(
      expect.objectContaining({ status: 'delivered', token: TOKEN }),
    );
    expect(billStatus).toHaveBeenCalledTimes(1);
  });

  it('a read racing the sweep or an operator never writes over a state that moved meanwhile', async () => {
    const { service, store } = build(
      [row({ status: 'processing', providerCheckedAt: ago(60 * SECONDS) })],
      {
        // While the provider is being asked, an operator records a refund for this bill.
        billStatus: () => {
          const r = store.get('bill-1');
          if (r) {
            r.status = 'refunded';
            r.refundReference = 'REFUND-1';
          }
          return Promise.resolve({ status: 'successful', token: TOKEN });
        },
      },
    );
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(store.get('bill-1')?.status).toBe('refunded');
    expect(out.status).toBe('refunded');
  });

  it('never buys: the biller is not called by a status read', async () => {
    const { service, payBill } = build(
      [row({ status: 'processing', providerCheckedAt: ago(60 * SECONDS) })],
      { billStatus: { status: 'successful' } },
    );
    await service.statusOf('buyer-1', 'bill-1');
    expect(payBill).not.toHaveBeenCalled();
  });
});
