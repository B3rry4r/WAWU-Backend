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
  readFeeSimulation,
  readStatementLine,
  readWebhookSubscription,
} from '../areas/reconcile-readers';
import { NuvionClient } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';

/**
 * NUV-08, the reconciliation area against Nuvion's stand-in over a socket:
 * a month of a statement across pages, with fee and running balance, for a
 * person and for WAWU's operational account; the walk of months behind
 * `listTransactions`; the subscription and fee simulation calls. No database
 * and no host but loopback (outbound-guard.ts).
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
          data: [
            {
              transfer_id: 'x',
              type: 'inflow',
              amount: 1.5,
              currency: 'NGN',
              status: 'successful',
            },
          ],
          meta: { pagination: { has_next: false, order: 'asc', limit: 100 } },
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
          data: [{ transfer_id: 'bad', type: 'sideways' }],
          meta: { pagination: { has_next: false, order: 'asc', limit: 100 } },
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
          data: [],
          meta: {
            pagination: {
              has_next: true,
              order: 'asc',
              limit: 100,
              next_cursor: null,
            },
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

  it('the subscription: listed, renewed for the period it had, and the renewal refused when Nuvion errs', async () => {
    const sub = rec.addSubscription({
      expires_in: 86_400,
      expires_at: clock + 3_600_000,
    });
    const listed = await area.listWebhookSubscriptions();
    const mine = listed.find((s) => s.id === sub.id)!;
    expect(mine.url).toBe(sub.url);
    expect(mine.expiresInSeconds).toBe(86_400);
    expect(mine.expiresAt!.getTime()).toBe(sub.expires_at);

    const renewed = await area.renewWebhookSubscription(sub.id, 86_400);
    expect(rec.renewals.at(-1)).toEqual({ expires_in: 86_400 });
    expect(renewed.expiresAt!.getTime()).toBeGreaterThan(
      sub.created + 3_600_000,
    );

    rec.failRenewals = true;
    await expect(
      area.renewWebhookSubscription(sub.id, 86_400),
    ).rejects.toBeInstanceOf(NuvionError);
    rec.failRenewals = false;
    await expect(
      area.renewWebhookSubscription('../x', 86_400),
    ).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('a fee simulation asks from the operational account and moves nothing', async () => {
    rec.simulatedFee = ({ amount }) => (amount >= 500_000 ? 2_500 : 1_500);
    const small = await area.simulateFee({
      paymentType: 'book-transfer',
      type: 'outflow',
      amountKobo: 100_000,
    });
    const big = await area.simulateFee({
      paymentType: 'bank-transfer',
      type: 'outflow',
      amountKobo: 600_000,
    });
    expect([small, big]).toEqual([1_500, 2_500]);
    expect(rec.simulations.at(-1)).toEqual({
      account_id: OPERATIONAL,
      amount: 600_000,
      currency: 'NGN',
      type: 'outflow',
      payment_type: 'bank-transfer',
    });
    expect(
      standin.seen.filter(
        (r) => r.method === 'POST' && r.path === '/transfers',
      ),
    ).toHaveLength(0);
  });

  describe('the readers refuse what is not whole kobo', () => {
    const base = {
      transfer_id: '01TRF0000000000000000001',
      type: 'outflow',
      amount: 1_000,
      currency: 'NGN',
      status: 'successful',
    };
    it('a line', () => {
      expect(readStatementLine(base).ok).toBe(true);
      for (const bad of [
        { ...base, amount: 10.5 },
        { ...base, amount: 0 },
        { ...base, applicable_fee: -1 },
        { ...base, applicable_fee: 1.5 },
        { ...base, balance_after: '100' },
        { ...base, type: 'sideways' },
        { ...base, transfer_id: '../x' },
        { ...base, currency: 'naira' },
        { ...base, status: '' },
      ]) {
        expect(readStatementLine(bad).ok).toBe(false);
      }
    });
    it('a subscription and a simulation', () => {
      const created = Date.UTC(2026, 9, 1);
      const s = readWebhookSubscription({
        id: '01WHK0000000000000000001',
        url: 'https://x.test/api/hub/webhooks/nuvion',
        created,
        expires_in: 3_600,
        enabled_events: ['inflows.completed', 5],
      });
      expect(s!.expiresAt!.getTime()).toBe(created + 3_600_000);
      expect(s!.events).toEqual(['inflows.completed']);
      expect(readWebhookSubscription({ id: 'x' })).toBeNull();
      expect(readFeeSimulation({ applicable_fee: 40 })).toBe(40);
      expect(readFeeSimulation({ applicable_fee: 40.5 })).toBeNull();
      expect(readFeeSimulation({ applicable_fee: -1 })).toBeNull();
      expect(readFeeSimulation('no')).toBeNull();
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
