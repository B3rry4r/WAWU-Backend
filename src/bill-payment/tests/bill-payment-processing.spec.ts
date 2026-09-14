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
 * Flutterwave's own documentation is explicit that a non-throwing response
 * from the bill-payment endpoint means the request was ACCEPTED, not that
 * the biller actually delivered — delivery is confirmed asynchronously.
 * `verifyAndDeliver` used to record any non-throwing response as `delivered`
 * immediately, which is how a customer could be charged, see a "delivered"
 * receipt, and never receive the airtime when the async step later failed
 * with nothing anywhere set up to catch it.
 *
 * These tests cover the fix: acceptance lands as `processing`, and only a
 * real provider-status check (manual `reconcile`, or the automated sweep)
 * may write `delivered` or `failed`.
 */

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  createdAt: Date;
};

function buildPrisma(rows: Row[]) {
  const store = new Map<string, Row>(rows.map((r) => [r.id, { ...r }]));

  function matchesClause(row: Row, clause: Record<string, unknown>): boolean {
    if ('status' in clause && row.status !== clause.status) return false;
    const createdAt = clause.createdAt as { lt?: Date } | undefined;
    if (createdAt?.lt && !(row.createdAt < createdAt.lt)) return false;
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
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const row = store.get(where.id);
        if (!row || (where.status && row.status !== where.status)) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
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
      findMany: ({
        where,
      }: {
        where: { OR?: Record<string, unknown>[] } & Record<string, unknown>;
      }) => {
        const clauses = where.OR ?? [where];
        const matched = [...store.values()].filter((row) =>
          clauses.some((clause) => matchesClause(row, clause)),
        );
        return Promise.resolve(matched);
      },
    },
  } as unknown as PrismaService;

  return { prisma, store };
}

function build(rows: Row[], overrides: { billStatus?: unknown } = {}) {
  const { prisma, store } = buildPrisma(rows);
  const bills = {
    payBill: () =>
      Promise.resolve({ reference: 'FLW-REF-1', code: '00', fee: 10 }),
    billStatus: () => Promise.resolve(overrides.billStatus ?? {}),
  } as unknown as FlutterwaveBillsClient;
  const verifier = {
    verify: () => Promise.resolve({ transactionId: 'flw-txn-1' }),
  } as unknown as FlutterwaveCheckoutVerifier;
  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord } as unknown as AdminOpsAuditService;
  const service = new BillPaymentService(prisma, bills, verifier, audit);
  return { service, store, auditRecord };
}

const ADMIN: AdminActor = {
  id: 'admin-1',
  email: 'finance@wawu.dev',
  role: AdminRole.finance,
};

function row(overrides: Partial<Row>): Row {
  return {
    id: 'bill-1',
    buyerWawuId: 'buyer-1',
    category: 'AIRTIME',
    billerCode: 'BIL099',
    itemCode: 'AT099',
    billerName: 'MTN Nigeria',
    customerRef: '08030000000',
    amount: 1000,
    fee: 0,
    flutterwaveTxRef: 'wawu-bill-x',
    flutterwaveTxId: null,
    providerReference: null,
    providerStatus: null,
    failureReason: null,
    status: 'pending',
    createdAt: new Date(),
    deliveredAt: null,
    refundReference: null,
    refundedAt: null,
    ...overrides,
  };
}

describe('bill payments: acceptance is not delivery', () => {
  it('lands a successful payBill() call as `processing`, not `delivered`', async () => {
    const { service, store } = build([row({ status: 'pending' })]);

    const result = await service.verifyAndDeliver(
      'buyer-1',
      'bill-1',
      'flw-txn-1',
    );

    expect(result.status).toBe('processing');
    expect(result.deliveredAt).toBeNull();
    expect(store.get('bill-1')?.status).toBe('processing');
    expect(store.get('bill-1')?.deliveredAt).toBeNull();
  });
});

describe('bill payments: reconciling a `processing` bill', () => {
  it('resolves to `delivered` when the provider confirms it, and audits the change', async () => {
    const { service, store, auditRecord } = build(
      [row({ status: 'processing' })],
      { billStatus: { status: 'successful' } },
    );

    const outcome = await service.reconcile('bill-1', ADMIN);

    expect(outcome.changed).toBe(true);
    expect(outcome.billPayment.status).toBe('delivered');
    expect(store.get('bill-1')?.status).toBe('delivered');
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const [actor, entry] = auditRecord.mock.calls[0] as [
      AdminActor,
      { action: string; detail: { newStatus: string } },
    ];
    expect(actor).toBe(ADMIN);
    expect(entry.action).toBe('bill_reconciled');
    expect(entry.detail.newStatus).toBe('delivered');
  });

  it('resolves to `failed` when the provider reports it failed', async () => {
    const { service, store } = build([row({ status: 'processing' })], {
      billStatus: { status: 'failed' },
    });

    const outcome = await service.reconcile('bill-1', ADMIN);

    expect(outcome.changed).toBe(true);
    expect(outcome.billPayment.status).toBe('failed');
    expect(store.get('bill-1')?.status).toBe('failed');
  });

  it('leaves the row alone when the provider answer is still unclear', async () => {
    const { service, store } = build([row({ status: 'processing' })], {
      billStatus: { status: 'pending_review' },
    });

    const outcome = await service.reconcile('bill-1', ADMIN);

    expect(outcome.changed).toBe(false);
    expect(store.get('bill-1')?.status).toBe('processing');
  });
});

describe('bill payments: automated reconciliation sweep', () => {
  it('settles a `processing` bill stuck past its cutoff, without an audit trail', async () => {
    const stuckAt = new Date(Date.now() - 60 * 60_000);
    const { service, store, auditRecord } = build(
      [row({ id: 'stuck-1', status: 'processing', createdAt: stuckAt })],
      { billStatus: { status: 'successful' } },
    );

    await service.reconcilePendingDeliveries();

    expect(store.get('stuck-1')?.status).toBe('delivered');
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('leaves a fresh `processing` bill alone — delivery may still be in flight', async () => {
    const { service, store } = build(
      [row({ id: 'fresh-1', status: 'processing', createdAt: new Date() })],
      { billStatus: { status: 'successful' } },
    );

    await service.reconcilePendingDeliveries();

    expect(store.get('fresh-1')?.status).toBe('processing');
  });

  it('also sweeps a stuck `paid` bill the biller was never called back for', async () => {
    const stuckAt = new Date(Date.now() - 60 * 60_000);
    const { service, store } = build(
      [row({ id: 'paid-stuck', status: 'paid', createdAt: stuckAt })],
      { billStatus: { status: 'failed' } },
    );

    await service.reconcilePendingDeliveries();

    expect(store.get('paid-stuck')?.status).toBe('failed');
  });
});
