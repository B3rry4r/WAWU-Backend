import { ModuleRef } from '@nestjs/core';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { LedgerMovementInput } from '../../money/ledger/ledger.interface';
import type { LedgerService } from '../../money/ledger/ledger.service';
import { LedgerProviderConflictError } from '../../money/ledger/ledger.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { BookTransferReading, NuvionBookArea } from '../areas/book';
import {
  type BookStatus,
  bookStatusMayMove,
  type BookTransferRead,
  type BookTransferRow,
  type NuvionBookStore,
} from '../areas/book-store';
import { NuvionBookRecorder } from '../handlers/book';
import { NuvionBookHandler } from '../handlers/book.handler';
import type { NuvionDelivery } from '../handlers/nuvion-handler.interface';

/**
 * The decisions of NUV-05's webhook handler, one by one, on fakes: what a
 * delivery is (ours or not), what is read back, what an event that is ahead
 * of Nuvion's record does, and what reaches the ledger. The same handler
 * runs against the real database, the real ledger and the real stand-in in
 * nuvion-book-money.contract.spec.ts.
 */

const REF = 'wawu-pay-0123';
const ID = '01HXYZTRANSFER000000000001';
const ACCOUNT = '01HXYZACCOUNT00000000001';
const ENTITY = '01HXYZENTITY0000000000001';

function row(over: Partial<BookTransferRow> = {}): BookTransferRow {
  return {
    id: 'r1',
    reference: REF,
    nuvionId: ID,
    fromAccountId: ACCOUNT,
    fromEntityId: ENTITY,
    fromOperational: false,
    fromAccountNumber: '5000000001',
    toAccountId: '01HXYZOPERATIONAL00000001',
    toEntityId: null,
    toOperational: true,
    toAccountNumber: 'NVXYT1GUCM',
    toNuvionBan: 'NVXYT1GUCM',
    amountKobo: 100_000n,
    feeKobo: null,
    narration: 'WAWU purchase',
    status: 'pending',
    statusReason: null,
    sentAt: new Date(),
    answeredAt: null,
    readAt: null,
    ...over,
  };
}

function reading(over: Partial<BookTransferReading> = {}): BookTransferReading {
  return {
    id: ID,
    entityId: ENTITY,
    accountId: ACCOUNT,
    amountKobo: 100_000,
    feeKobo: 1_500,
    currency: 'NGN',
    status: 'successful',
    type: 'outflow',
    paymentType: 'book-transfer',
    uniqueReference: REF,
    counterpartyId: null,
    narration: 'WAWU purchase',
    createdAt: new Date('2026-10-11T10:00:00Z'),
    statusReason: 'processing_complete',
    feeStated: true,
    sourcePaymentId: null,
    ...over,
  };
}

/** The transfer object as a delivery's `data` carries it. */
function wire(t: BookTransferReading, over: Record<string, unknown> = {}) {
  return {
    id: t.id,
    entity_id: t.entityId,
    account_id: t.accountId,
    amount: t.amountKobo,
    applicable_fee: t.feeKobo,
    currency: t.currency,
    status: t.status,
    status_reason: t.statusReason,
    type: t.type,
    payment_type: t.paymentType,
    unique_reference: t.uniqueReference,
    narration: t.narration,
    created: t.createdAt?.getTime(),
    meta: {},
    ...over,
  };
}

function delivery(
  event: string,
  data: unknown,
  over: Partial<NuvionDelivery> = {},
): NuvionDelivery {
  return {
    id: 'd1',
    eventId: 'e1',
    event,
    resourceId: null,
    entityId: null,
    data,
    receivedAt: new Date(),
    attempts: 1,
    ...over,
  };
}

interface Harness {
  recorder: NuvionBookRecorder;
  reads: Array<{ id: string }>;
  recorded: LedgerMovementInput[];
  logged: BookTransferRead[];
  readOf: jest.Mock;
}

function harness(opts: {
  rows?: BookTransferRow[];
  fresh?: BookTransferReading | Error;
  ledgerRows?: Record<string, string[]>;
  ledgerError?: Error;
}): Harness {
  const rows = opts.rows ?? [row()];
  const logged: BookTransferRead[] = [];
  const recorded: LedgerMovementInput[] = [];
  const store: NuvionBookStore = {
    findPersonAccount: jest.fn(),
    begin: jest.fn(),
    byReference: (r) =>
      Promise.resolve(rows.find((x) => x.reference === r) ?? null),
    byNuvionId: (i) =>
      Promise.resolve(rows.find((x) => x.nuvionId === i) ?? null),
    reopen: jest.fn(),
    markRefused: jest.fn(),
    recordRead: (ref, read) => {
      logged.push(read);
      const r = rows.find((x) => x.reference === ref) ?? null;
      return Promise.resolve(
        r
          ? { ...r, nuvionId: read.nuvionId, status: read.status as BookStatus }
          : null,
      );
    },
  };
  const readOf = jest.fn(() => {
    const f = opts.fresh ?? reading();
    return f instanceof Error ? Promise.reject(f) : Promise.resolve(f);
  });
  const area = { readOf, store } as unknown as NuvionBookArea;
  const ledger = {
    entriesFor: (account: string, side: string) =>
      Promise.resolve(
        opts.ledgerRows?.[`${account}:${side}`] ?? [`e-${account}-${side}`],
      ),
    record: (input: LedgerMovementInput) => {
      if (opts.ledgerError) return Promise.reject(opts.ledgerError);
      recorded.push(input);
      return Promise.resolve({
        entryId: 'x',
        created: false,
        discrepancy: null,
      });
    },
  } as unknown as LedgerService;
  const prisma = {
    fintavaLedgerEntry: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve({
          walletKind: where.id.includes('NVXYT1GUCM') ? 'merchant' : 'user',
          wawuUserId: where.id.includes('NVXYT1GUCM') ? null : 'u1',
          accountNumber: where.id.includes('NVXYT1GUCM')
            ? 'NVXYT1GUCM'
            : '5000000001',
          category: 'purchase',
          amountKobo: 100_000n,
          feeKobo: 1_500n,
          totalKobo: 101_500n,
        }),
    },
  } as unknown as PrismaService;
  return {
    recorder: new NuvionBookRecorder(prisma, area, store, ledger),
    reads: [],
    recorded,
    logged,
    readOf,
  };
}

describe("NUV-05 handler: a book transfer's deliveries", () => {
  describe('what is ours', () => {
    it.each([
      ['a payout (bank-transfer)', { payment_type: 'bank-transfer' }],
      [
        'a card refund',
        { payment_type: 'card-debit-reversal', type: 'inflow' },
      ],
      ['no rail at all', { payment_type: undefined }],
    ])('%s is left alone and nothing is read', async (_what, over) => {
      const h = harness({});
      const r = await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading(), over)),
      );
      expect(r.outcome).toBe('done');
      expect(h.readOf).not.toHaveBeenCalled();
      expect(h.recorded).toEqual([]);
    });

    it('a book transfer the log does not hold is left alone (a move on the dashboard)', async () => {
      const h = harness({ rows: [] });
      const r = await h.recorder.onOutflow(
        delivery(
          'outflows.completed',
          wire(
            reading({ id: '01HXYZSOMEONEELSE00000001', uniqueReference: 'x' }),
          ),
        ),
      );
      expect(r).toMatchObject({ outcome: 'done' });
      expect(r.note).toMatch(/not a transfer WAWU sent/);
      expect(h.readOf).not.toHaveBeenCalled();
    });

    it('is found by our reference when the log has no id yet, and the id is adopted', async () => {
      const h = harness({ rows: [row({ nuvionId: null })] });
      const r = await h.recorder.onOutflow(
        delivery('outflows.created', wire(reading({ status: 'pending' }))),
      );
      expect(r.outcome).toBe('done');
      expect(h.readOf).toHaveBeenCalledWith(expect.anything(), ID);
      expect(h.logged[0]).toMatchObject({ nuvionId: ID });
    });

    it('a delivery naming another transfer than the one under our reference is a stop', async () => {
      const h = harness({});
      const r = await h.recorder.onOutflow(
        delivery(
          'outflows.completed',
          wire(reading({ id: '01HXYZANOTHERTRANSFER0001' })),
        ),
      );
      expect(r.outcome).toBe('failed');
      expect(r.note).toMatch(/another transfer/);
      expect(h.readOf).not.toHaveBeenCalled();
      expect(h.recorded).toEqual([]);
    });

    it.each([
      ['not an object', 'x'],
      ['no id', { amount: 5, currency: 'NGN', status: 'successful' }],
      ['a fractional amount', { ...wire(reading()), amount: 10.5 }],
    ])('an unreadable delivery (%s) is a stop', async (_what, data) => {
      const h = harness({});
      const r = await h.recorder.onOutflow(
        delivery('outflows.completed', data),
      );
      expect(r.outcome).toBe('failed');
      expect(h.recorded).toEqual([]);
    });
  });

  describe('what is read back', () => {
    it('Nuvion out of reach waits, then is kept for review past the limit', async () => {
      const down = new WalletProviderError({
        kind: 'unavailable',
        provider: 'nuvion',
        operation: 'get transfer',
      });
      const h = harness({ fresh: down });
      const r = await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(r.outcome).toBe('wait');
      const old = await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading()), {
          receivedAt: new Date(Date.now() - 73 * 3_600_000),
        }),
      );
      expect(old.outcome).toBe('failed');
      expect(old.note).toMatch(/kept for review/);
    });

    it('a record that is not the transfer we sent is a stop and nothing is recorded', async () => {
      const bad = new WalletProviderError({
        kind: 'bad_response',
        provider: 'nuvion',
        operation: 'get transfer',
        messages: ["Nuvion's record says 100001 kobo"],
      });
      const h = harness({ fresh: bad });
      const r = await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(r.outcome).toBe('failed');
      expect(h.recorded).toEqual([]);
      expect(h.logged).toEqual([]);
    });

    it.each(['outflows.created', 'outflows.completed', 'outflows.refunded'])(
      'a status word we do not know is a stop (%s)',
      async (event) => {
        const h = harness({ fresh: reading({ status: 'quarantined' }) });
        const r = await h.recorder.onOutflow(delivery(event, wire(reading())));
        expect(r.outcome).toBe('failed');
        expect(r.note).toMatch(/not one we know/);
        expect(h.recorded).toEqual([]);
        expect(h.logged).toEqual([]);
      },
    );
  });

  describe("an event ahead of Nuvion's record waits", () => {
    it.each([
      ['outflows.completed', 'pending'],
      ['outflows.completed', 'processing'],
      ['outflows.failed', 'pending'],
      ['outflows.cancelled', 'processing'],
      ['outflows.refunded', 'pending'],
      ['outflows.refunded', 'successful'],
    ])('%s while the record says %s', async (event, status) => {
      const h = harness({ fresh: reading({ status }) });
      const r = await h.recorder.onOutflow(delivery(event, wire(reading())));
      expect(r.outcome).toBe('wait');
      expect(h.recorded).toEqual([]);
    });

    it('outflows.created is never ahead: a queued transfer records nothing', async () => {
      const h = harness({ fresh: reading({ status: 'pending' }) });
      const r = await h.recorder.onOutflow(
        delivery('outflows.created', wire(reading({ status: 'pending' }))),
      );
      expect(r.outcome).toBe('done');
      expect(h.recorded).toEqual([]);
    });
  });

  describe('what reaches the ledger is the record, not the event', () => {
    const statusesOf = (h: Harness) => h.recorded.map((m) => m.status);

    it('successful completes both sides, at the charge the record states', async () => {
      const h = harness({});
      const r = await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(r.outcome).toBe('done');
      expect(h.recorded).toHaveLength(2);
      const [out, inn] = h.recorded;
      expect(out).toMatchObject({
        direction: 'out',
        status: 'completed',
        amountKobo: 100_000,
        feeKobo: 1_500,
        totalKobo: 101_500,
        source: 'webhook',
        references: { customerReference: REF, fintavaTransactionId: ID },
      });
      expect(inn).toMatchObject({
        direction: 'in',
        status: 'completed',
        feeKobo: 0,
        totalKobo: 100_000,
      });
      expect(h.logged[0]).toMatchObject({
        status: 'successful',
        feeKobo: 1_500n,
      });
    });

    it('a stale failed for a completed transfer records completed', async () => {
      const h = harness({});
      await h.recorder.onOutflow(
        delivery('outflows.failed', wire(reading({ status: 'failed' }))),
      );
      expect(statusesOf(h)).toEqual(['completed', 'completed']);
    });

    it("failed (and cancelled) fails both sides with the reason the payment reads, at the rows' own figures", async () => {
      for (const event of ['outflows.failed', 'outflows.cancelled']) {
        const h = harness({ fresh: reading({ status: 'failed' }) });
        await h.recorder.onOutflow(delivery(event, wire(reading())));
        expect(statusesOf(h)).toEqual(['failed', 'failed']);
        expect(h.recorded[0]).toMatchObject({
          feeKobo: 1_500,
          totalKobo: 101_500,
          failureReason: 'Fintava reports this transfer failed.',
        });
      }
    });

    it('reversed reverses both sides; the credit record names the transfer it reverses', async () => {
      const credit = wire(
        reading({
          id: '01HXYZCREDITRECORD000001',
          uniqueReference: `${REF}_reversal`,
        }),
        { type: 'inflow', meta: { source_payment_id: ID } },
      );
      const h = harness({ fresh: reading({ status: 'reversed' }) });
      const r = await h.recorder.onOutflow(
        delivery('outflows.refunded', credit),
      );
      expect(r.outcome).toBe('done');
      expect(statusesOf(h)).toEqual(['reversed', 'reversed']);
      expect(h.readOf).toHaveBeenCalledWith(expect.anything(), ID);
    });

    it("a record that states no charge leaves the row's charge standing", async () => {
      const h = harness({
        fresh: reading({ feeStated: false, feeKobo: 0 }),
      });
      await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(h.recorded[0]).toMatchObject({
        direction: 'out',
        figuresStand: true,
      });
      expect(h.recorded[0].feeKobo).toBe(1_500);
    });

    it("a side with no ledger row yet is the sender's to write; a side with two is a stop for review", async () => {
      const none = harness({
        ledgerRows: { '5000000001:out': [], 'NVXYT1GUCM:in': [] },
      });
      const r = await none.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(r.outcome).toBe('done');
      expect(none.recorded).toEqual([]);
      expect(r.note).toMatch(/no out row yet/);
      const two = harness({
        ledgerRows: { '5000000001:out': ['a', 'b'] },
      });
      const t = await two.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(t.note).toMatch(/2 out rows hold this reference/);
      expect(two.recorded).toHaveLength(1);
      expect(two.recorded[0].direction).toBe('in');
    });

    it("the ledger refusing the sighting (another provider's row) is a stop kept for review", async () => {
      const h = harness({
        ledgerError: new LedgerProviderConflictError(['x']),
      });
      const r = await h.recorder.onOutflow(
        delivery('outflows.completed', wire(reading())),
      );
      expect(r.outcome).toBe('failed');
    });
  });
});

describe('NUV-05 handler: where it runs', () => {
  function handlerWith(found: Map<unknown, unknown>) {
    const moduleRef = {
      get: (token: unknown) => {
        if (!found.has(token)) throw new Error('not found');
        return found.get(token);
      },
    } as unknown as ModuleRef;
    return new NuvionBookHandler({} as PrismaService, moduleRef);
  }

  it("lists the five outflow events and is NUV-05's", () => {
    const h = handlerWith(new Map());
    expect(h.task).toBe('NUV-05');
    expect([...h.events].sort()).toEqual([
      'outflows.cancelled',
      'outflows.completed',
      'outflows.created',
      'outflows.failed',
      'outflows.refunded',
    ]);
  });

  it('waits when the provider is not mounted, and leaves the delivery for a Nuvion server when Fintava runs', async () => {
    const none = await handlerWith(new Map()).handle(
      delivery('outflows.completed', {}),
    );
    expect(none).toEqual({
      outcome: 'wait',
      note: 'the wallet provider is not mounted',
    });
    const fintava = {
      name: 'fintava',
      label: 'Fintava',
    } as unknown as WalletProvider;
    const r = await handlerWith(new Map([[WALLET_PROVIDER, fintava]])).handle(
      delivery('outflows.completed', {}),
    );
    expect(r.outcome).toBe('wait');
    expect(r.note).toMatch(/Fintava; left for a Nuvion server/);
  });
});

describe('NUV-05 log: a status only moves forward', () => {
  const MOVES: Array<[BookStatus, BookStatus, boolean]> = [
    ['sending', 'pending', true],
    ['sending', 'successful', true],
    ['sending', 'failed', true],
    ['sending', 'reversed', true],
    // `refused` is written by markRefused, not through this table.
    ['sending', 'refused', false],
    ['refused', 'sending', true],
    ['refused', 'pending', false],
    ['refused', 'successful', false],
    ['pending', 'processing', true],
    ['pending', 'successful', true],
    ['pending', 'failed', true],
    ['pending', 'reversed', true],
    ['processing', 'successful', true],
    ['processing', 'failed', true],
    ['processing', 'pending', false],
    ['successful', 'reversed', true],
    ['successful', 'pending', false],
    ['successful', 'failed', false],
    ['successful', 'successful', false],
    ['failed', 'successful', false],
    ['failed', 'pending', false],
    ['failed', 'reversed', false],
    ['reversed', 'successful', false],
    ['reversed', 'failed', false],
    ['reversed', 'pending', false],
  ];
  it.each(MOVES)('%s to %s: %s', (from, to, allowed) => {
    expect(bookStatusMayMove(from, to)).toBe(allowed);
  });
});
