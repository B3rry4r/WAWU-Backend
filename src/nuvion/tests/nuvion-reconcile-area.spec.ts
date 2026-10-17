import { NuvionAccountsStandin } from '../../../test/nuvion/accounts-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NuvionReconcileStandin } from '../../../test/nuvion/reconcile-standin';
import {
  NUVION_STATEMENT_MAX_MONTHS,
  NuvionReconcileArea,
  type NuvionStatementScope,
} from '../areas/reconcile';
import {
  readStatementLine,
  readWebhookSubscription,
} from '../areas/reconcile-readers';
import { NuvionClient } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';

/**
 * NUV-08, the reconciliation area against Nuvion's stand-in over a socket:
 * a month of a statement across pages, with fee and running balance, for a
 * person and for WAWU's operational account; the walk of months behind
 * `listTransactions`; the subscription list. The shapes are Nuvion's public
 * docs (their own example bodies are in DOCS_STATEMENT and DOCS_WEBHOOK). No
 * database and no host but loopback (outbound-guard.ts).
 */

const OPERATIONAL = '01HXYZOPERATIONAL000000001';
const PARENT_ENTITY = '01HXYZPARENTENTITY0000001';
const SEPT_15 = Date.UTC(2026, 8, 15, 10, 0, 0);

/**
 * A transfer id that cannot collide: the stand-in's own `standinId` pads with
 * trailing zeros, so two counters that differ only by trailing zeros meet.
 */
let uidSeq = 0;
const uid = () => `01TRF08${String((uidSeq += 1)).padStart(19, '0')}`;

/**
 * The statement body in Nuvion's docs (api-reference__accounts.md, "Get
 * account statements", the example response from line 929), cut to four of
 * its lines: ids, dates, amounts, fees, balances and statuses as printed.
 */
const DOCS_STATEMENT = {
  status: 'success',
  message: 'Account statement retrieved successfully',
  data: {
    account_id: '01HXYZ7890ABCDEFGHJKMNPQRS',
    account_holder: 'Alex Johnson',
    account_currency: 'USD',
    ban: 'NVN0000012345',
    generated_at: '2026-05-25T15:22:54.373Z',
    period: {
      start_date: '2026-05-01T00:00:00.000Z',
      end_date: '2026-05-25T15:22:54.373Z',
    },
    balances: {
      opening_balance: 947893,
      closing_balance: 187687,
      total_credits: 0,
      total_debits: 754179,
      total_fees: 6027,
    },
    transactions: [
      {
        transaction_id: '01HXYZ8002ABCDEFGHJKMNPQRS',
        date: '2026-05-04T06:14:33.045Z',
        type: 'debit',
        description: 'Test Swift Payout',
        counterparty: {
          name: 'TEST_Acme Legal Asia',
          account_number: 'XXXXXXXXXXXXXXXXXX4484',
        },
        amount: 5893,
        fee: 590,
        net_amount: 5303,
        running_balance: 447893,
        reference: 'REF-1785824070816-3337',
        status: 'pending',
        currency: 'USD',
        fx: {
          source_currency: 'USD',
          destination_currency: 'EUR',
          rate: 0.848481,
          source_amount: 5893,
          destination_amount: 5000,
        },
      },
      {
        transaction_id: '01HXYZ8004ABCDEFGHJKMNPQRS',
        date: '2026-05-05T10:57:02.662Z',
        type: 'debit',
        description: 'Test USD SWIFT Payout',
        counterparty: {
          name: 'Acme IP Pty Ltd',
          account_number: 'XXXXXXXX1158',
        },
        amount: 5000,
        fee: 5025,
        net_amount: -25,
        running_balance: 437868,
        reference: 'REF-1785927416953-273',
        status: 'completed',
        currency: 'USD',
      },
      {
        transaction_id: '01HXYZ8009ABCDEFGHJKMNPQRS',
        date: '2026-05-14T12:55:07.303Z',
        type: 'debit',
        description: 'Nuvion Flex 90 FR order',
        counterparty: { name: 'Nuvion Flex 90', account_number: null },
        amount: 10000,
        fee: 0,
        net_amount: 10000,
        running_balance: 194307,
        reference: '01HXYZ8109ABCDEFGHJKMNPQRS',
        status: 'completed',
        currency: 'USD',
      },
    ],
    pagination: {
      order: 'asc',
      has_next: false,
      has_previous: false,
      limit: 100,
      next_cursor: null,
      previous_cursor: null,
      total_transactions: 3,
    },
  },
};

/**
 * The webhook object in Nuvion's docs (api-reference__webhooks.md, "Get a
 * webhook", the example response), with the optional groups it lists.
 */
const DOCS_WEBHOOK = {
  id: '01HXYZ9001ABCDEFGHJKMNPQRS',
  entity_id: '01HXYZ1234ABCDEFGHJKMNPQRS',
  url: 'https://webhooks.example.com/nuvion',
  expires_in: 31536000,
  enabled_events: {
    all: false,
    entities: { created: false, updated: false },
    accounts: { created: true, updated: true, deleted: true },
    inflows: { completed: true, failed: true },
    outflows: {
      created: true,
      completed: true,
      failed: true,
      cancelled: false,
      refunded: false,
    },
  },
  preferred_events: ['accounts.all', 'inflows.all'],
  description: 'Production payment notifications',
  tags: ['payments', 'production'],
  status: 'active',
  created: 1744056000000,
  updated: 1744056000000,
  deleted: 0,
  stats: { total_webhooks_sent: 1482 },
};

describe('NUV-08: reconciliation area', () => {
  const standin = new NuvionStandin();
  const accounts = new NuvionAccountsStandin(standin);
  const rec = new NuvionReconcileStandin(standin, accounts);
  let guard: OutboundGuard;
  let area: NuvionReconcileArea;
  let clock = Date.UTC(2026, 8, 20, 12, 0, 0);

  beforeAll(async () => {
    guard = guardOutbound();
    await standin.start();
    accounts.install();
    rec.install();
    area = new NuvionReconcileArea(
      new NuvionClient(standin.settings(), 'nv_test_sk_NUV08areaKEY0000000000'),
      () => clock,
    );
  });

  afterAll(async () => {
    await standin.stop();
    guard.restore();
  });

  afterEach(() => {
    expect(guard.violations).toEqual([]);
  });

  /** A person's naira account, created in June 2026. */
  const person = (
    entityId = `01ENT${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
  ) => {
    const account = accounts.addAccount(entityId, {
      created: Date.UTC(2026, 5, 1),
    });
    return { entityId, account };
  };

  it('a month of a person statement is every movement across pages, with fee and running balance', async () => {
    const { entityId, account } = person();
    for (let i = 0; i < 250; i += 1) {
      accounts.addInflow(account, {
        id: uid(),
        amount: 10_000 + i,
        applicable_fee: i % 7,
        created: SEPT_15 + i * 1000,
      });
    }
    rec.statementRequests.length = 0;
    const scope: NuvionStatementScope = { accountId: account.id, entityId };
    const month = await area.statementOfMonth(scope, 2026, 9);
    expect(month.unreadable).toBe(0);
    expect(month.lines).toHaveLength(250);
    expect(new Set(month.lines.map((l) => l.transferId)).size).toBe(250);
    // three pages of at most 100, pending lines asked for, the month named
    expect(rec.statementRequests).toHaveLength(3);
    expect(rec.statementRequests[0]).toMatchObject({
      year: '2026',
      month: '9',
      include_pending: 'true',
      limit: '100',
      entity_id: entityId,
    });
    expect(rec.statementRequests[1].cursor).toBeDefined();
    const first = month.lines[0];
    expect(first.direction).toBe('in');
    expect(first.feeKobo).toBe(0);
    expect(first.amountKobo).toBe(10_000);
    expect(first.balanceAfterKobo).toBe(10_000);
    expect(month.lines.at(-1)!.balanceAfterKobo).toBe(
      rec.balanceOf(account.id),
    );
    for (const l of month.lines) {
      expect(l.feeKobo).not.toBeNull();
      expect(l.balanceAfterKobo).not.toBeNull();
    }
  });

  it('WAWU operational account: asked as the parent entity, outflow with its fee, balance after', async () => {
    const op = accounts.addAccount(PARENT_ENTITY, {
      id: OPERATIONAL,
      type: 'operational',
      created: Date.UTC(2026, 5, 1),
    });
    accounts.addInflow(op, {
      id: uid(),
      amount: 500_000,
      applicable_fee: 0,
      payment_type: 'book-transfer',
      created: SEPT_15,
    });
    accounts.addInflow(op, {
      id: uid(),
      amount: 120_000,
      applicable_fee: 2_500,
      type: 'outflow',
      payment_type: 'bank-transfer',
      created: SEPT_15 + 60_000,
    });
    rec.statementRequests.length = 0;
    const month = await area.statementOfMonth(
      await area.scopeOf({ kind: 'merchant' }),
      2026,
      9,
    );
    expect(rec.statementRequests[0].entity_id).toBeUndefined();
    expect(
      month.lines.map((l) => [
        l.direction,
        l.amountKobo,
        l.feeKobo,
        l.balanceAfterKobo,
      ]),
    ).toEqual([
      ['in', 500_000, 0, 500_000],
      ['out', 120_000, 2_500, 377_500],
    ]);
  });

  it('listTransactions walks months newest first, in pages, and in the other order', async () => {
    const { entityId, account } = person();
    const months = [
      Date.UTC(2026, 6, 10, 9), // July
      Date.UTC(2026, 7, 10, 9), // August
      Date.UTC(2026, 8, 10, 9), // September
    ];
    let n = 0;
    for (const at of months) {
      for (let i = 0; i < 4; i += 1) {
        n += 1;
        accounts.addInflow(account, {
          id: uid(),
          amount: 1_000 * n,
          applicable_fee: n,
          created: at + i * 60_000,
        });
      }
    }
    const holder = { kind: 'customer' as const, customerId: entityId };
    const seen: string[] = [];
    let page = 1;
    for (;;) {
      const res = await area.listTransactions(holder, {
        page,
        take: 5,
        order: 'DESC',
      });
      seen.push(...res.items.map((t) => t.id));
      for (const t of res.items) {
        expect(t.feeKobo).not.toBeNull();
        expect(t.balanceAfterKobo).not.toBeNull();
        expect(t.direction).toBe('in');
        expect(t.outcome).toBe('completed');
      }
      if (!res.hasNextPage) break;
      page += 1;
      expect(page).toBeLessThan(10);
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    const first = await area.listTransactions(holder, { page: 1, take: 100 });
    const times = first.items.map((t) => Date.parse(t.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(first.items[0].amountKobo).toBe(12_000n + 0n);
    // reading page after page did not read an early month twice
    const julyReads = rec.statementRequests.filter(
      (r) => r.entity_id === entityId && r.month === '7',
    );
    expect(julyReads).toHaveLength(1);
    const asc = await area.listTransactions(holder, {
      page: 1,
      take: 100,
      order: 'ASC',
    });
    expect(asc.items.map((t) => t.id)).toEqual(
      [...first.items].reverse().map((t) => t.id),
    );
    // the walk stops at the month the account was created in (June has nothing)
    expect(
      rec.statementRequests.filter(
        (r) => r.entity_id === entityId && r.month === '5',
      ),
    ).toHaveLength(0);
    expect(NUVION_STATEMENT_MAX_MONTHS).toBeGreaterThan(12);
  });

  it('a month that cannot be read in full is an error, never a shorter list', async () => {
    const { entityId, account } = person();
    accounts.addInflow(account, { id: uid(), created: SEPT_15 });
    standin.next((req) => ({
      status: 200,
      body: {
        status: 'success',
        message: 'OK',
        data: {
          transactions: [
            {
              transaction_id: '01TRF08BADAMOUNT00000001',
              type: 'credit',
              amount: 1.5,
              currency: 'NGN',
              status: 'completed',
            },
          ],
          pagination: { has_next: false, order: 'asc', limit: 100 },
        },
      },
      headers: { 'X-Test': req.path },
    }));
    const month = await area.statementOfMonth(
      { accountId: account.id, entityId },
      2026,
      9,
    );
    expect(month.lines).toHaveLength(0);
    expect(month.unreadable).toBe(1);

    // listTransactions refuses a month with an unreadable line.
    const other = person();
    accounts.addInflow(other.account, { id: uid(), created: SEPT_15 });
    // the scope lookup and the account read come first; garble the statement
    standin.on('GET', /^\/accounts\/[A-Za-z0-9]+\/statements$/, (req) => ({
      status: 200,
      body: {
        status: 'success',
        message: 'OK',
        data: {
          transactions: [{ transaction_id: 'bad', type: 'sideways' }],
          pagination: { has_next: false, order: 'asc', limit: 100 },
        },
      },
      headers: { 'X-Test': req.path },
    }));
    await expect(
      area.listTransactions(
        { kind: 'customer', customerId: other.entityId },
        { page: 1, take: 10 },
      ),
    ).rejects.toMatchObject({ kind: 'bad_response' });
    // restore the stand-in's own route for the specs after this one
    rec.install();
  });

  it('a page that says more follow but gives no new cursor is an error', async () => {
    const { entityId, account } = person();
    standin.on('GET', /^\/accounts\/[A-Za-z0-9]+\/statements$/, () => ({
      status: 200,
      body: {
        status: 'success',
        message: 'OK',
        data: {
          transactions: [],
          pagination: {
            has_next: true,
            order: 'asc',
            limit: 100,
            next_cursor: null,
          },
        },
      },
    }));
    await expect(
      area.statementOfMonth({ accountId: account.id, entityId }, 2026, 9),
    ).rejects.toBeInstanceOf(NuvionError);
    rec.install();
  });

  it('a person with no naira account has no statement: not_found, never an empty list', async () => {
    await expect(
      area.listTransactions(
        { kind: 'customer', customerId: '01ENTNOACCOUNT00000000001' },
        { page: 1, take: 10 },
      ),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('an id that is not Nuvion-shaped is refused before any call', async () => {
    const before = standin.seen.length;
    await expect(
      area.statementOfMonth({ accountId: '../x', entityId: null }, 2026, 9),
    ).rejects.toMatchObject({ kind: 'validation' });
    await expect(
      area.statementOfMonth(
        { accountId: OPERATIONAL, entityId: null },
        2026,
        13,
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(standin.seen.length).toBe(before);
  });

  it('the subscription list: read from the docs shape, and no write is made to Nuvion', async () => {
    const sub = rec.addSubscription({ expires_in: 86_400 });
    const gone = rec.addSubscription({ status: 'inactive' });
    const before = standin.seen.length;
    const listed = await area.listWebhookSubscriptions();
    const mine = listed.find((s) => s.id === sub.id)!;
    expect(mine).toMatchObject({
      url: sub.url,
      status: 'active',
      active: true,
      expiresInSeconds: 86_400,
    });
    expect(mine.events).toEqual([
      'inflows.completed',
      'inflows.failed',
      'outflows.created',
      'outflows.completed',
      'outflows.failed',
    ]);
    expect(listed.find((s) => s.id === gone.id)).toMatchObject({
      status: 'inactive',
      active: false,
    });
    // only the documented read; nothing renews, rotates or simulates
    expect(
      standin.seen.slice(before).map((r) => `${r.method} ${r.path}`),
    ).toEqual(['GET /entity-webhooks']);
    expect(area).not.toHaveProperty('renewWebhookSubscription');
    expect(area).not.toHaveProperty('simulateFee');
  });

  it("Nuvion's own statement example is read: transactions, pagination, transaction_id, ISO date, completed and pending", async () => {
    const { entityId, account } = person();
    standin.next(() => ({ status: 200, body: DOCS_STATEMENT }));
    const month = await area.statementOfMonth(
      { accountId: account.id, entityId },
      2026,
      5,
    );
    expect(month.unreadable).toBe(0);
    expect(
      month.lines.map((l) => [
        l.transferId,
        l.createdAt!.toISOString(),
        l.direction,
        l.amountKobo,
        l.feeKobo,
        l.balanceAfterKobo,
        l.status,
        l.outcome,
        l.reference,
      ]),
    ).toEqual([
      [
        '01HXYZ8002ABCDEFGHJKMNPQRS',
        '2026-05-04T06:14:33.045Z',
        'out',
        5893,
        590,
        447893,
        'pending',
        'pending',
        'REF-1785824070816-3337',
      ],
      [
        '01HXYZ8004ABCDEFGHJKMNPQRS',
        '2026-05-05T10:57:02.662Z',
        'out',
        5000,
        5025,
        437868,
        'completed',
        'completed',
        'REF-1785927416953-273',
      ],
      [
        '01HXYZ8009ABCDEFGHJKMNPQRS',
        '2026-05-14T12:55:07.303Z',
        'out',
        10000,
        0,
        194307,
        'completed',
        'completed',
        '01HXYZ8109ABCDEFGHJKMNPQRS',
      ],
    ]);
  });

  it("a statement's lines older than the window are dropped by their ISO date", async () => {
    const { entityId, account } = person();
    const scope: NuvionStatementScope = { accountId: account.id, entityId };
    accounts.addInflow(account, {
      id: uid(),
      created: Date.UTC(2026, 8, 2, 10),
    });
    const recent = accounts.addInflow(account, {
      id: uid(),
      created: Date.UTC(2026, 8, 20, 9),
    });
    const got = await area.statementSince(
      scope,
      new Date(Date.UTC(2026, 8, 19, 12)),
      new Date(Date.UTC(2026, 8, 20, 12)),
    );
    expect(got.lines.map((l) => l.transferId)).toEqual([recent.id]);
  });

  it('a statement answered in the old guessed shape is refused, not read as empty', async () => {
    const { entityId, account } = person();
    standin.next(() => ({
      status: 200,
      body: {
        status: 'success',
        message: 'OK',
        data: {
          data: [],
          meta: { pagination: { has_next: false, order: 'asc', limit: 100 } },
        },
      },
    }));
    await expect(
      area.statementOfMonth({ accountId: account.id, entityId }, 2026, 9),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });

  describe('the readers refuse what is not whole kobo', () => {
    const base = DOCS_STATEMENT.data.transactions[1];
    it('a line', () => {
      expect(readStatementLine(base).ok).toBe(true);
      for (const bad of [
        { ...base, amount: 10.5 },
        { ...base, amount: 0 },
        { ...base, fee: -1 },
        { ...base, fee: 1.5 },
        { ...base, running_balance: '100' },
        { ...base, type: 'sideways' },
        { ...base, type: 'inflow' },
        { ...base, transaction_id: '../x' },
        {
          ...base,
          transfer_id: base.transaction_id,
          transaction_id: undefined,
        },
        { ...base, currency: 'naira' },
        { ...base, status: '' },
        { ...base, status: 'sideways' },
      ]) {
        expect(readStatementLine(bad).ok).toBe(false);
      }
    });
    it('a line with no readable date is kept, with no time', () => {
      const r = readStatementLine({ ...base, date: 'not a date' });
      expect(r.ok && r.line.createdAt).toBeNull();
      const none = readStatementLine({ ...base, date: undefined });
      expect(none.ok && none.line.createdAt).toBeNull();
    });
    it('a subscription: the docs object, status read, no expiry date made up', () => {
      const s = readWebhookSubscription(DOCS_WEBHOOK);
      expect(s).toMatchObject({
        id: DOCS_WEBHOOK.id,
        status: 'active',
        active: true,
        expiresInSeconds: 31536000,
      });
      expect(s).not.toHaveProperty('expiresAt');
      expect(s!.events).toContain('inflows.completed');
      expect(s!.events).not.toContain('inflows.cancelled');
      expect(
        readWebhookSubscription({ ...DOCS_WEBHOOK, status: 'inactive' }),
      ).toMatchObject({ status: 'inactive', active: false });
      expect(
        readWebhookSubscription({ ...DOCS_WEBHOOK, status: undefined }),
      ).toMatchObject({ status: null, active: false });
      expect(
        readWebhookSubscription({
          ...DOCS_WEBHOOK,
          enabled_events: { all: true },
        })!.events,
      ).toEqual(['all']);
      expect(readWebhookSubscription({ id: 'x' })).toBeNull();
    });
  });

  it('keeps the clock honest: the walk is reused only for a minute', async () => {
    const { entityId, account } = person();
    accounts.addInflow(account, { id: uid(), created: SEPT_15 });
    const holder = { kind: 'customer' as const, customerId: entityId };
    await area.listTransactions(holder, { page: 1, take: 10 });
    const reads = () =>
      rec.statementRequests.filter((r) => r.entity_id === entityId).length;
    const once = reads();
    await area.listTransactions(holder, { page: 1, take: 10 });
    expect(reads()).toBe(once);
    clock += 61_000;
    await area.listTransactions(holder, { page: 1, take: 10 });
    expect(reads()).toBeGreaterThan(once);
  });
});
