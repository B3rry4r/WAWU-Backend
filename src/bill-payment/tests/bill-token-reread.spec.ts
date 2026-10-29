import { BillPaymentService } from '../bill-payment.service';
import { FlutterwaveBillsClient } from '../flutterwave-bills.client';
import { isPowerBill } from '../bill-delivery';
import type { FlutterwaveCheckoutVerifier } from '../../common/flutterwave/checkout-verifier';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type {
  AdminActor,
  AdminOpsAuditService,
} from '../../common/audit/admin-ops-audit.service';
import { AdminRole } from '../../../generated/prisma/enums';

/**
 * BILLS-09 fix round 1 (verifier, HIGH): the token was probably never stored.
 *
 * Flutterwave's "Get status of a bill payment" page shows `token` only in its default ("Ok") shape; the verbose shape
 * (`?verbose=1`, the one the client has always asked for) carries `extra` and `product_details` and no `token`. So for a
 * successful power bill the Hub also reads the plain shape (`?verbose=0`) and keeps its `token`, before settling. A delivered
 * power bill that still has no token is asked again by the buyer's status read, under the same 20 second claim, for up to 24
 * hours after delivery. Never a purchase.
 */

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  createdAt: Date;
};
const TOKEN = '4821 0937 5510 2286 7734';
const SECONDS = 1000;
const HOURS = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

function buildPrisma(rows: Row[]) {
  const store = new Map<string, Row>(rows.map((r) => [r.id, { ...r }]));
  type Where = {
    id?: string;
    status?: string;
    token?: null;
    OR?: { providerCheckedAt?: null | { lt: Date } }[];
  };
  const matches = (row: Row, where: Where) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.token === null && row.token != null) return false;
    if (where.OR) {
      const checked = row.providerCheckedAt as Date | null | undefined;
      const ok = where.OR.some((clause) => {
        if (clause.providerCheckedAt === null) return checked == null;
        if (clause.providerCheckedAt)
          return checked != null && checked < clause.providerCheckedAt.lt;
        return true;
      });
      if (!ok) return false;
    }
    return true;
  };
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
  verbose?: unknown;
  plain?: unknown;
  delayMs?: number;
}

function build(rows: Row[], options: Options = {}) {
  const { prisma, store } = buildPrisma(rows);
  const billStatus = jest.fn(async () => {
    if (options.delayMs)
      await new Promise((r) => setTimeout(r, options.delayMs));
    return options.verbose ?? {};
  });
  const billStatusPlain = jest.fn(async () => {
    if (options.delayMs)
      await new Promise((r) => setTimeout(r, options.delayMs));
    if (options.plain instanceof Error) throw options.plain;
    return options.plain ?? {};
  });
  const payBill = jest.fn();
  const bills = {
    payBill,
    billStatus,
    billStatusPlain,
  } as unknown as FlutterwaveBillsClient;
  const verifier = {
    verify: () => Promise.resolve({ transactionId: 't' }),
  } as unknown as FlutterwaveCheckoutVerifier;
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AdminOpsAuditService;
  const service = new BillPaymentService(prisma, bills, verifier, audit);
  return { service, store, billStatus, billStatusPlain, payBill };
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
    providerReference: 'FLW-REF-1',
    providerStatus: null,
    failureReason: null,
    token: null,
    units: null,
    providerCheckedAt: ago(60 * SECONDS),
    status: 'processing',
    createdAt: ago(5 * 60_000),
    deliveredAt: null,
    refundReference: null,
    refundedAt: null,
    ...overrides,
  };
}

describe('isPowerBill', () => {
  it.each([
    'POWER',
    'power',
    'Utility Bills',
    'UTILITYBILLS',
    'Electricity',
    'Power Bills',
  ])('%s is a power bill', (c) => {
    expect(isPowerBill(c)).toBe(true);
  });
  it.each([
    'AIRTIME',
    'DATA_BUNDLE',
    'Mobile Data Service',
    'CABLEBILLS',
    'Cable Bill Payment',
    'Internet Service',
    '',
    null,
  ])('%s is not', (c) => {
    expect(isPowerBill(c as string)).toBe(false);
  });
});

describe('FlutterwaveBillsClient: the two status shapes', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    delete process.env.FLUTTERWAVE_SECRET_KEY;
  });

  it('asks the verbose shape as before and the plain shape with verbose=0, by the same reference', async () => {
    process.env.FLUTTERWAVE_SECRET_KEY = 'test-key-not-real';
    const urls: string[] = [];
    globalThis.fetch = jest.fn((input: RequestInfo | URL) => {
      urls.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({ status: 'success', data: { token: TOKEN } }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const client = new FlutterwaveBillsClient();
    await client.billStatus('wawu-bill-abc');
    const plain = await client.billStatusPlain('wawu-bill-abc');
    expect(urls[0]).toMatch(/\/bills\/wawu-bill-abc\?verbose=1$/);
    expect(urls[1]).toMatch(/\/bills\/wawu-bill-abc\?verbose=0$/);
    expect(plain).toEqual({ token: TOKEN });
  });
});

describe('a successful power bill: the plain shape is read before settling', () => {
  it('the buyer status read keeps the token the plain shape carries (the verbose shape has none)', async () => {
    const { service, store, billStatus, billStatusPlain } = build([row()], {
      verbose: { status: 'successful', extra: null, product_details: {} },
      plain: {
        tx_ref: 'wawu-bill-x',
        amount: 5000,
        fee: 0,
        extra: null,
        flw_ref: null,
        token: TOKEN,
      },
    });
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out).toMatchObject({ status: 'delivered', token: TOKEN });
    expect(billStatus).toHaveBeenCalledTimes(1);
    expect(billStatusPlain).toHaveBeenCalledTimes(1);
    expect(billStatusPlain).toHaveBeenCalledWith('wawu-bill-x');
    expect(store.get('bill-1')?.token).toBe(TOKEN);
  });

  it('keeps units the plain shape carries too', async () => {
    const { service } = build([row()], {
      verbose: { status: 'successful' },
      plain: { token: TOKEN, extra: 'Units: 45.2' },
    });
    expect(await service.statusOf('buyer-1', 'bill-1')).toMatchObject({
      token: TOKEN,
      units: '45.2',
    });
  });

  it('the sweep and an operator reconcile do the same', async () => {
    const swept = build([row({ createdAt: ago(2 * HOURS) })], {
      verbose: { status: 'successful' },
      plain: { token: TOKEN },
    });
    await swept.service.reconcilePendingDeliveries();
    expect(swept.store.get('bill-1')).toMatchObject({
      status: 'delivered',
      token: TOKEN,
    });

    const reconciled = build([row()], {
      verbose: { status: 'successful' },
      plain: { token: TOKEN },
    });
    const out = await reconciled.service.reconcile('bill-1', ADMIN);
    expect(reconciled.store.get('bill-1')).toMatchObject({
      status: 'delivered',
      token: TOKEN,
    });
    expect(out.billPayment).not.toHaveProperty('token');
  });

  it('is not read when the verbose answer already has the token, or the bill is not a power bill, or it is not successful', async () => {
    const has = build([row()], {
      verbose: { status: 'successful', token: TOKEN },
    });
    await has.service.statusOf('buyer-1', 'bill-1');
    expect(has.billStatusPlain).not.toHaveBeenCalled();

    const airtime = build([row({ category: 'AIRTIME' })], {
      verbose: { status: 'successful' },
    });
    await airtime.service.statusOf('buyer-1', 'bill-1');
    expect(airtime.billStatusPlain).not.toHaveBeenCalled();

    const pending = build([row()], { verbose: { status: 'pending' } });
    await pending.service.statusOf('buyer-1', 'bill-1');
    expect(pending.billStatusPlain).not.toHaveBeenCalled();

    const failed = build([row()], { verbose: { status: 'failed' } });
    await failed.service.statusOf('buyer-1', 'bill-1');
    expect(failed.billStatusPlain).not.toHaveBeenCalled();
  });

  it('a plain read that fails never stops the bill settling', async () => {
    const { service, store } = build([row()], {
      verbose: { status: 'successful' },
      plain: new Error('Could not reach the bill payment provider.'),
    });
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out).toMatchObject({ status: 'delivered', token: null });
    expect(store.get('bill-1')?.status).toBe('delivered');
  });

  it('a plain answer of the wrong shape stores nothing', async () => {
    const { service, store } = build([row()], {
      verbose: { status: 'successful' },
      plain: { token: { a: 1 }, extra: 12, units: ['5'] },
    });
    await service.statusOf('buyer-1', 'bill-1');
    expect(store.get('bill-1')).toMatchObject({
      status: 'delivered',
      token: null,
      units: null,
    });
  });
});

describe('a delivered power bill with no token is asked again, for 24 hours, under the 20 second claim', () => {
  const delivered = (over: Partial<Row> = {}) =>
    row({
      status: 'delivered',
      deliveredAt: ago(30 * 60_000),
      providerCheckedAt: ago(60 * SECONDS),
      ...over,
    });

  it('asks, keeps the token, and the bill stays delivered', async () => {
    const { service, store, billStatus, billStatusPlain } = build(
      [delivered()],
      {
        verbose: { status: 'successful' },
        plain: { token: TOKEN, extra: 'Units: 45.2' },
      },
    );
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out).toMatchObject({
      status: 'delivered',
      token: TOKEN,
      units: '45.2',
    });
    expect(billStatus).toHaveBeenCalledTimes(1);
    expect(billStatusPlain).toHaveBeenCalledTimes(1);
    expect(store.get('bill-1')?.providerCheckedAt).toBeInstanceOf(Date);
  });

  it('never buys, and a provider that now says failed does not undo a delivered bill', async () => {
    const { service, store, payBill } = build([delivered()], {
      verbose: { status: 'failed' },
      plain: {},
    });
    const out = await service.statusOf('buyer-1', 'bill-1');
    expect(out.status).toBe('delivered');
    expect(store.get('bill-1')?.status).toBe('delivered');
    expect(store.get('bill-1')?.failureReason).toBeNull();
    expect(payBill).not.toHaveBeenCalled();
  });

  it('three reads at once ask the provider once; the next within 20 seconds asks nobody', async () => {
    const { service, billStatus } = build([delivered()], {
      verbose: { status: 'successful' },
      plain: {},
      delayMs: 20,
    });
    await Promise.all(
      [1, 2, 3].map(() => service.statusOf('buyer-1', 'bill-1')),
    );
    expect(billStatus).toHaveBeenCalledTimes(1);
    await service.statusOf('buyer-1', 'bill-1');
    expect(billStatus).toHaveBeenCalledTimes(1);
  });

  it('is not asked after 24 hours, with a token, for another kind of bill, or checked a moment ago', async () => {
    const cases: Row[] = [
      delivered({ deliveredAt: ago(25 * HOURS) }),
      delivered({ token: TOKEN }),
      delivered({ category: 'AIRTIME' }),
      delivered({ providerCheckedAt: ago(5 * SECONDS) }),
      row({ status: 'failed' }),
      row({ status: 'refunded' }),
    ];
    for (const r of cases) {
      const { service, billStatus, billStatusPlain } = build([r], {
        verbose: { status: 'successful' },
        plain: { token: TOKEN },
      });
      await service.statusOf('buyer-1', 'bill-1');
      expect(billStatus).not.toHaveBeenCalled();
      expect(billStatusPlain).not.toHaveBeenCalled();
    }
  });

  it('a delivered bill with no delivery time counts from when it was created', async () => {
    const recent = build(
      [delivered({ deliveredAt: null, createdAt: ago(HOURS) })],
      { verbose: { status: 'successful' }, plain: {} },
    );
    await recent.service.statusOf('buyer-1', 'bill-1');
    expect(recent.billStatus).toHaveBeenCalledTimes(1);
    const old = build(
      [delivered({ deliveredAt: null, createdAt: ago(30 * HOURS) })],
      { verbose: { status: 'successful' }, plain: {} },
    );
    await old.service.statusOf('buyer-1', 'bill-1');
    expect(old.billStatus).not.toHaveBeenCalled();
  });

  it("another person's bill is not found and nothing is asked", async () => {
    const { service, billStatus } = build([delivered()], {
      verbose: {},
      plain: {},
    });
    await expect(service.statusOf('someone-else', 'bill-1')).rejects.toThrow(
      /not found/i,
    );
    expect(billStatus).not.toHaveBeenCalled();
  });
});
