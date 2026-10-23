import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NUVION_API_VERSION } from '../nuvion-config';
import { NuvionClient } from '../nuvion-client';
import { NuvionReconcileArea } from '../areas/reconcile';
import { readStatementLine } from '../areas/reconcile-readers';

/**
 * FIX-67: the LOCAL stand-in that the test stack runs
 * (scripts/dev/nuvion-standin.cjs) answers `GET /accounts/{id}/statements`
 * as Nuvion's docs describe it (api-reference__accounts.md, "Get account
 * statements", :690 to :931), built from the transfers it records, so the
 * nightly money check (`npm run money:check`) can read every wallet on a
 * stack. The script is started as a child process on a loopback port (the
 * kernel picks one, or STANDIN_SPEC_PORT), driven only through its own
 * routes, and read back through the Hub's real reader and area
 * (NuvionClient, NuvionReconcileArea). No database; no host but loopback.
 *
 * Checked: the documented fields and types of every line and of the summary;
 * paging by `limit` and `cursor`; a reference appears once on each account it
 * touched and a transaction id once per statement; the running balance and
 * the summary agree with the stand-in's own balance; pending lines only with
 * `include_pending`; the documented parameter errors; entity scoping.
 */

const SCRIPT = join(__dirname, '../../../scripts/dev/nuvion-standin.cjs');
const OPERATIONAL = '01STACKOPERATIONAL0000001';
const PARENT = '01STACKPARENTENTITY000001';
const BOOK_FEE = 100;
const BANK_FEE = 2500;

interface Line {
  transaction_id: string;
  date: string;
  type: string;
  description: string;
  counterparty: { name: string; account_number: string | null };
  amount: number;
  fee: number;
  net_amount: number;
  running_balance: number;
  reference: string;
  status: string;
  currency: string;
}
interface Statement {
  account_id: string;
  account_holder: string;
  account_currency: string;
  ban: string;
  address: Record<string, unknown>;
  generated_at: string;
  period: { start_date: string; end_date: string };
  balances: {
    opening_balance: number;
    closing_balance: number;
    total_credits: number;
    total_debits: number;
    total_fees: number;
  };
  transactions: Line[];
  pagination: {
    order: string;
    has_next: boolean;
    has_previous: boolean;
    limit: number;
    next_cursor: string | null;
    previous_cursor: string | null;
    total_transactions: number;
  };
}
interface Answer<T> {
  status: number;
  body: T;
}
interface Envelope {
  status: string;
  message: string;
  data: Statement;
  type?: string;
  validations?: Array<Record<string, { type: string; message: string }>>;
}
interface Person {
  entity: string;
  id: string;
  ban: string;
}

describe('FIX-67: the stand-in answers account statements', () => {
  let guard: OutboundGuard;
  let child: ChildProcess;
  let base = '';
  let area: NuvionReconcileArea;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  let ada: Person;
  let bo: Person;
  const ids: Record<string, string> = {};

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer<T>> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  const statementPath = (
    account: string,
    entity: string | null,
    more: Record<string, string | number> = {},
  ) => {
    const q = new URLSearchParams({
      year: String(year),
      month: String(month),
      ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, `${v}`])),
    });
    if (entity !== null) q.set('entity_id', entity);
    return `/accounts/${account}/statements?${q.toString()}`;
  };

  const statement = async (
    p: Person | null,
    more: Record<string, string | number> = {},
  ) => {
    const r = await call<Envelope>(
      'GET',
      statementPath(p ? p.id : OPERATIONAL, p ? p.entity : null, more),
    );
    expect(r.status).toBe(200);
    return r.body.data;
  };

  /** Every line of a month, a page at a time, the way the Hub's reader walks it. */
  async function allLines(
    p: Person | null,
    limit = 7,
    y = year,
    mo = month,
    pending: string | null = 'true',
  ): Promise<Statement[]> {
    const pages: Statement[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const r: Answer<Envelope> = await call<Envelope>(
        'GET',
        statementPath(p ? p.id : OPERATIONAL, p ? p.entity : null, {
          year: y,
          month: mo,
          limit,
          ...(pending === null ? {} : { include_pending: pending }),
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(r.status).toBe(200);
      pages.push(r.body.data);
      cursor = r.body.data.pagination.next_cursor;
      if (!r.body.data.pagination.has_next) return pages;
    }
    throw new Error('the statement has no end');
  }

  async function person(name: string): Promise<Person> {
    const e = await call<{ data: { entity: { id: string } } }>(
      'POST',
      '/individual-entities',
      { name, person: {} },
    );
    const entity = e.body.data.entity.id;
    const a = await call<{
      data: { account: { id: string; nuvion_ban: string } };
    }>('POST', '/accounts', {
      entity_id: entity,
      type: 'checking',
      currency: 'NGN',
    });
    return {
      entity,
      id: a.body.data.account.id,
      ban: a.body.data.account.nuvion_ban,
    };
  }

  async function book(
    from: Person | null,
    to: Person | null,
    amount: number,
    reference: string,
  ): Promise<string> {
    const r = await call<{ data: { id: string } }>('POST', '/transfers', {
      account_id: from ? from.id : OPERATIONAL,
      entity_id: from ? from.entity : PARENT,
      unique_reference: reference,
      amount,
      currency: 'NGN',
      payment_type: 'book-transfer',
      nuvion_ban: to ? to.ban : 'NVXSTACKOPS1',
      narration: `spec ${reference}`,
    });
    expect(r.status).toBe(201);
    ids[reference] = r.body.data.id;
    return r.body.data.id;
  }

  const settle = async (reference: string, status: string) => {
    const r = await call(
      'POST',
      `/__standin/transfers/${ids[reference]}/settle`,
      {
        status,
      },
    );
    expect(r.status).toBe(200);
  };

  const fund = async (p: Person, amount: number) => {
    const r = await call('POST', '/__standin/fund', {
      account_id: p.id,
      amount_kobo: amount,
    });
    expect(r.status).toBe(201);
  };

  const balanceOf = async (id: string) => {
    const r = await call<{ balance: { current: number } }>(
      'GET',
      `/__standin/account/${id}`,
    );
    return r.body.balance.current;
  };

  beforeAll(async () => {
    guard = guardOutbound();
    // A month turning while the spec runs would split its lines in two.
    const toTurn = Date.UTC(year, month, 1) - Date.now(); // the first of next month
    if (toTurn < 20_000) await new Promise((r) => setTimeout(r, toTurn + 500));

    child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        NUVION_STANDIN_PORT: process.env.STANDIN_SPEC_PORT ?? '0',
        HUB_WEBHOOK_URL: '',
        NUVION_WEBHOOK_SECRET: '',
        NUVION_FEE_BOOK_TRANSFER: String(BOOK_FEE),
        NUVION_FEE_BANK_PAYOUT: String(BANK_FEE),
        NUVION_FEE_INFLOW: '0',
        STANDIN_SETTLE_MS: '3600000', // a transfer settles when the spec says so
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    base = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(
        () => reject(new Error('the stand-in did not start')),
        10_000,
      );
      child.stdout?.on('data', (b: Buffer) => {
        out += b.toString();
        const hit = /on 127\.0\.0\.1:(\d+)/.exec(out);
        if (hit) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${hit[1]}`);
        }
      });
      child.once('exit', () =>
        reject(new Error(`the stand-in exited: ${out}`)),
      );
    });
    area = new NuvionReconcileArea(
      new NuvionClient(
        {
          baseUrl: base,
          environment: 'standin',
          apiVersion: NUVION_API_VERSION,
          operationalAccountId: OPERATIONAL,
          readTimeoutMs: 5_000,
          moneyTimeoutMs: 5_000,
          checkTimeoutMs: 5_000,
          resendSafetyMs: 60_000,
          retryAfterSeconds: 30,
        },
        'nv_test_sk_FIX67statementsKEY000000',
      ),
    );

    ada = await person('Ada Spec');
    bo = await person('Bo Spec');
    await fund(ada, 5_000_000);
    await fund(bo, 100_000);

    // Ada pays Bo; Ada pays WAWU (left pending); one fails; Bo pays Ada and it is reversed.
    await book(ada, bo, 100_000, 'spec-book');
    await settle('spec-book', 'successful');
    await book(ada, null, 30_000, 'spec-pending');
    await settle('spec-pending', 'successful');
    await book(ada, bo, 10_000, 'spec-failed');
    await settle('spec-failed', 'failed');
    await book(bo, ada, 5_000, 'spec-reversed');
    await settle('spec-reversed', 'successful');
    await settle('spec-reversed', 'reversed');

    // A bank send, completed and then reversed by the bank (a credit record of its own).
    const cp = await call<{ data: { id: string } }>('POST', '/counterparties', {
      entity_id: ada.entity,
      type: 'individual',
      // Dev refuses an individual without an email and an address (FIX-97): the
      // stand-in does too, so the spec gives both (the one input changed here).
      profile: {
        first_name: 'Cy',
        last_name: 'Spec',
        email: 'cy.spec@example.test',
        address: { line1: '1 Spec Road', city: 'Lagos', country: 'NG' },
      },
    });
    const detail = await call<{ data: { id: string } }>(
      'POST',
      '/payment-details',
      {
        entity_id: ada.entity,
        counterparty_id: cp.body.data.id,
        payment_method: 'bank-transfer',
        currency: 'NGN',
        country: 'NG',
        bank_code: '044',
        account_number: '0123456789',
        account_holder_name: 'Cy Spec',
        bank_name: 'Access Bank',
      },
    );
    const bank = await call<{ data: { id: string } }>('POST', '/transfers', {
      account_id: ada.id,
      entity_id: ada.entity,
      unique_reference: 'spec-bank',
      amount: 20_000,
      currency: 'NGN',
      payment_type: 'bank-transfer',
      counterparty_id: cp.body.data.id,
      payment_detail_id: detail.body.data.id,
    });
    expect(bank.status).toBe(201);
    ids['spec-bank'] = bank.body.data.id;
    await settle('spec-bank', 'successful');
    await settle('spec-bank', 'reversed');

    // Enough small transfers to need a second page of the Hub's own page size (100).
    for (let i = 1; i <= 105; i += 1) {
      await book(ada, null, 10, `spec-many-${i}`);
      await settle(`spec-many-${i}`, 'successful');
    }
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const gone = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGTERM');
      await gone;
    }
    guard.restore();
  });

  afterEach(() => {
    expect(guard.violations).toEqual([]);
  });

  it('answers the documented envelope, summary and line fields', async () => {
    const s = await statement(ada, { limit: 100, include_pending: 'true' });
    expect(Object.keys(s).sort()).toEqual(
      [
        'account_holder',
        'account_currency',
        'account_id',
        'address',
        'balances',
        'ban',
        'generated_at',
        'pagination',
        'period',
        'transactions',
      ].sort(),
    );
    expect(s.account_id).toBe(ada.id);
    expect(s.account_holder).toBe('Ada Spec');
    expect(s.account_currency).toBe('NGN');
    expect(s.ban).toBe(ada.ban);
    expect(Object.keys(s.address).sort()).toEqual(
      [
        'city',
        'country_code',
        'line_1',
        'line_2',
        'line_3',
        'postal_code',
        'state',
      ].sort(),
    );
    expect(s.period.start_date).toBe(
      new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    );
    expect(Date.parse(s.generated_at)).not.toBeNaN();
    expect(Object.keys(s.balances).sort()).toEqual(
      [
        'closing_balance',
        'opening_balance',
        'total_credits',
        'total_debits',
        'total_fees',
      ].sort(),
    );
    expect(s.pagination.order).toBe('asc');
    expect(s.transactions).toHaveLength(100);
    expect(s.pagination).toMatchObject({ limit: 100, has_next: true });
    for (const t of s.transactions) {
      expect(Object.keys(t).sort()).toEqual(
        [
          'amount',
          'counterparty',
          'currency',
          'date',
          'description',
          'fee',
          'net_amount',
          'reference',
          'running_balance',
          'status',
          'transaction_id',
          'type',
        ].sort(),
      );
      expect(['credit', 'debit']).toContain(t.type);
      expect(['completed', 'pending', 'failed']).toContain(t.status);
      expect(t.currency).toBe('NGN');
      expect(Number.isSafeInteger(t.amount)).toBe(true);
      expect(Number.isSafeInteger(t.fee)).toBe(true);
      expect(Number.isSafeInteger(t.running_balance)).toBe(true);
      expect(Date.parse(t.date)).not.toBeNaN();
      expect(Object.keys(t.counterparty).sort()).toEqual([
        'account_number',
        'name',
      ]);
      // Masked, never a whole number (counterparty.account_number, :831).
      if (t.counterparty.account_number !== null) {
        expect(t.counterparty.account_number).toMatch(/^X{6}.{4}$/);
      }
      expect('fx' in t).toBe(false);
      // The Hub's reader accepts every line.
      expect(readStatementLine(t).ok).toBe(true);
    }
    // Oldest to newest (:804).
    const times = s.transactions.map((t) => Date.parse(t.date));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('shows each move once on each account it touched, with its amount, direction, reference and time', async () => {
    const adaLines = (await allLines(ada, 50)).flatMap((p) => p.transactions);
    const boLines = (await allLines(bo, 50)).flatMap((p) => p.transactions);
    const opLines = (await allLines(null, 50)).flatMap((p) => p.transactions);

    for (const lines of [adaLines, boLines, opLines]) {
      expect(new Set(lines.map((l) => l.transaction_id)).size).toBe(
        lines.length,
      );
      const keyed = lines.map((l) => `${l.reference}|${l.type}`);
      expect(new Set(keyed).size).toBe(keyed.length);
    }
    const by = (lines: Line[], ref: string) =>
      lines.filter((l) => l.reference === ref);

    // A book transfer: a debit on the payer with the fee, a credit on the payee, same reference.
    const [d] = by(adaLines, 'spec-book');
    const [c] = by(boLines, 'spec-book');
    expect(by(adaLines, 'spec-book')).toHaveLength(1);
    expect(by(boLines, 'spec-book')).toHaveLength(1);
    expect(d).toMatchObject({
      transaction_id: ids['spec-book'],
      type: 'debit',
      amount: 100_000,
      fee: BOOK_FEE,
      status: 'completed',
    });
    expect(c).toMatchObject({
      transaction_id: ids['spec-book'],
      type: 'credit',
      amount: 100_000,
      fee: 0,
      status: 'completed',
    });
    expect(Date.parse(c.date)).toBeGreaterThanOrEqual(Date.parse(d.date));

    // Money to WAWU: on Ada as a debit, on the operational account as a credit.
    expect(by(adaLines, 'spec-pending')).toMatchObject([
      { type: 'debit', amount: 30_000 },
    ]);
    expect(by(opLines, 'spec-pending')).toMatchObject([
      { type: 'credit', amount: 30_000 },
    ]);

    // A failed transfer: one line, failed, and it moved nothing (Bo has no line for it).
    expect(by(adaLines, 'spec-failed')).toMatchObject([
      { status: 'failed', type: 'debit' },
    ]);
    expect(by(boLines, 'spec-failed')).toHaveLength(0);

    // A reversed book transfer: the original and the return, on both accounts.
    expect(by(boLines, 'spec-reversed').map((l) => l.type)).toEqual(['debit']);
    expect(by(boLines, 'spec-reversed_reversal').map((l) => l.type)).toEqual([
      'credit',
    ]);
    expect(by(adaLines, 'spec-reversed').map((l) => l.type)).toEqual([
      'credit',
    ]);
    expect(by(adaLines, 'spec-reversed_reversal').map((l) => l.type)).toEqual([
      'debit',
    ]);

    // A bank send the bank returned: the debit (completed, amount and fee) and the bank's credit.
    expect(by(adaLines, 'spec-bank')).toMatchObject([
      { type: 'debit', amount: 20_000, fee: BANK_FEE, status: 'completed' },
    ]);
    expect(by(adaLines, 'spec-bank_reversal')).toMatchObject([
      { type: 'credit', amount: 20_000 + BANK_FEE, status: 'completed' },
    ]);

    // Add money: a credit with its own reference.
    expect(
      adaLines.filter((l) => l.description === 'Top up from my bank'),
    ).toHaveLength(1);

    // The transfer count: every transfer the spec made is one line on its payer.
    const many = adaLines.filter((l) => l.reference.startsWith('spec-many-'));
    expect(many).toHaveLength(105);
    expect(new Set(many.map((l) => l.reference)).size).toBe(105);
  });

  it('pages by limit and cursor with no line twice or missed', async () => {
    const whole = (await allLines(ada, 100)).flatMap((p) => p.transactions);
    expect(whole.length).toBeGreaterThan(100);
    const pages = await allLines(ada, 7);
    expect(pages.length).toBe(Math.ceil(whole.length / 7));
    const got = pages.flatMap((p) =>
      p.transactions.map((t) => t.transaction_id),
    );
    expect(got).toEqual(whole.map((t) => t.transaction_id));
    expect(new Set(got).size).toBe(got.length);
    pages.forEach((p, i) => {
      const last = i === pages.length - 1;
      expect(p.pagination.total_transactions).toBe(whole.length);
      expect(p.pagination.limit).toBe(7);
      expect(p.pagination.has_previous).toBe(i > 0);
      expect(p.pagination.has_next).toBe(!last);
      expect(p.pagination.next_cursor).toBe(
        last ? null : p.transactions[p.transactions.length - 1].transaction_id,
      );
      expect(p.pagination.previous_cursor).toBe(
        i > 0 ? pages[i - 1].transactions[6].transaction_id : null,
      );
      if (!last) expect(p.transactions).toHaveLength(7);
    });
    // The default limit is 20 (:719).
    const dflt = await statement(ada, { include_pending: 'true' });
    expect(dflt.transactions).toHaveLength(20);
    expect(dflt.pagination.limit).toBe(20);
    // A page of the middle, started from a cursor by hand.
    const middle = await call<Envelope>(
      'GET',
      statementPath(ada.id, ada.entity, {
        limit: 3,
        include_pending: 'true',
        cursor: whole[2].transaction_id,
      }),
    );
    expect(middle.body.data.transactions.map((t) => t.transaction_id)).toEqual(
      whole.slice(3, 6).map((t) => t.transaction_id),
    );
  });

  it('is read whole by the Hub area across its own pages, and its balance agrees with the stand-in', async () => {
    for (const p of [ada, bo, null]) {
      const scope = {
        accountId: p ? p.id : OPERATIONAL,
        entityId: p ? p.entity : null,
      };
      const read = await area.statementOfMonth(scope, year, month);
      expect(read.unreadable).toBe(0);
      const windows = await allLines(p, 100);
      const lines = windows.flatMap((w) => w.transactions);
      expect(read.lines.map((l) => l.transferId)).toEqual(
        lines.map((l) => l.transaction_id),
      );
      // Everything has settled: the last running balance is the account's balance.
      const last = read.lines[read.lines.length - 1];
      expect(last.balanceAfterKobo).toBe(await balanceOf(scope.accountId));
    }
  });

  it('summarises the month: opening plus credits less debits and fees is closing', async () => {
    for (const p of [ada, bo, null]) {
      const s = await statement(p, { include_pending: 'true', limit: 100 });
      const b = s.balances;
      expect(b.opening_balance).toBe(p === null ? 100_000_000 : 0);
      expect(
        b.opening_balance + b.total_credits - b.total_debits - b.total_fees,
      ).toBe(b.closing_balance);
      expect(b.closing_balance).toBe(await balanceOf(p ? p.id : OPERATIONAL));
    }
    // The totals are the sums of the completed lines (a pending line is left out, :736).
    const lines = (await allLines(ada, 100)).flatMap((p) => p.transactions);
    const done = lines.filter((l) => l.status === 'completed');
    const b = (await statement(ada, { limit: 1 })).balances;
    expect(b.total_credits).toBe(
      done.filter((l) => l.type === 'credit').reduce((n, l) => n + l.amount, 0),
    );
    expect(b.total_debits).toBe(
      done.filter((l) => l.type === 'debit').reduce((n, l) => n + l.amount, 0),
    );
    expect(b.total_fees).toBe(done.reduce((n, l) => n + l.fee, 0));
  });

  it('leaves a pending line out unless include_pending is true, and a pending line moves nothing', async () => {
    const held = await book(ada, null, 7_000, 'spec-held');
    const before = await statement(ada, {
      limit: 100,
      include_pending: 'true',
    });
    const withHeld = await allLines(ada, 100);
    const wanted = withHeld
      .flatMap((p) => p.transactions)
      .find((t) => t.reference === 'spec-held');
    expect(wanted).toMatchObject({
      transaction_id: held,
      status: 'pending',
      type: 'debit',
    });
    // Its running balance is the one before it; the summary leaves it out (:736).
    const all = withHeld.flatMap((p) => p.transactions);
    const at = all.findIndex((t) => t.reference === 'spec-held');
    expect(wanted?.running_balance).toBe(all[at - 1].running_balance);
    expect(before.balances.closing_balance).toBe(
      all[all.length - 1].running_balance,
    );

    // Left out by default and with include_pending=false, on every page.
    for (const flag of [null, 'false']) {
      const lines = (await allLines(ada, 40, year, month, flag)).flatMap(
        (pg) => pg.transactions,
      );
      expect(lines.some((t) => t.reference === 'spec-held')).toBe(false);
      expect(lines.some((t) => t.status === 'pending')).toBe(false);
      expect(lines).toHaveLength(all.length - 1);
    }
    const stand = await balanceOf(ada.id);
    expect(before.balances.closing_balance - stand).toBe(BOOK_FEE + 7_000);

    await settle('spec-held', 'successful');
    const after = await statement(ada, { limit: 100, include_pending: 'true' });
    expect(after.balances.closing_balance).toBe(await balanceOf(ada.id));
  });

  it('answers a month with nothing in it and a month the account came after', async () => {
    const past = await statement(ada, { year: year - 1, month });
    expect(past.transactions).toEqual([]);
    expect(past.pagination).toMatchObject({
      has_next: false,
      has_previous: false,
      next_cursor: null,
      previous_cursor: null,
      total_transactions: 0,
    });
    expect(past.balances).toEqual({
      opening_balance: 0,
      closing_balance: 0,
      total_credits: 0,
      total_debits: 0,
      total_fees: 0,
    });
    const nextYear = month === 12 ? year + 1 : year;
    const next = await statement(ada, {
      year: nextYear,
      month: (month % 12) + 1,
    });
    expect(next.transactions).toEqual([]);
    expect(next.balances.opening_balance).toBe(await balanceOf(ada.id));
    expect(next.balances.closing_balance).toBe(await balanceOf(ada.id));
  });

  it('refuses what the docs make an error', async () => {
    const q = (extra: string, entity: string | null = ada.entity) =>
      `/accounts/${ada.id}/statements?${extra}${entity ? `&entity_id=${entity}` : ''}`;
    const invalid = async (path: string, field: string) => {
      const r = await call<Envelope>('GET', path);
      expect(r.status).toBe(400);
      expect(r.body.status).toBe('error');
      expect(r.body.type).toBe('error_validation_error');
      expect(Object.keys(r.body.validations?.[0] ?? {})).toEqual([field]);
    };
    await invalid(q(`month=${month}`), 'year');
    await invalid(q(`year=${year}`), 'month');
    await invalid(q(`year=${year}&month=13`), 'month');
    await invalid(q(`year=${year}&month=0`), 'month');
    await invalid(q(`year=abc&month=${month}`), 'year');
    await invalid(q(`year=${year}&month=${month}&limit=0`), 'limit');
    await invalid(q(`year=${year}&month=${month}&limit=101`), 'limit');
    await invalid(
      q(`year=${year}&month=${month}&include_pending=maybe`),
      'include_pending',
    );
    await invalid(
      q(`year=${year}&month=${month}&cursor=01NOSUCHLINE`),
      'cursor',
    );

    for (const path of [
      // an account that does not exist
      `/accounts/01NOSUCHACCOUNT0000000001/statements?year=${year}&month=${month}&entity_id=${ada.entity}`,
      // someone else's entity, and none at all, for a person's account
      q(`year=${year}&month=${month}`, bo.entity),
      q(`year=${year}&month=${month}`, null),
      // WAWU's own account asked as a person
      `/accounts/${OPERATIONAL}/statements?year=${year}&month=${month}&entity_id=${ada.entity}`,
    ]) {
      const r = await call<Envelope>('GET', path);
      expect(r.status).toBe(404);
      expect(r.body.type).toBe('error_resource_not_found');
    }
    // WAWU's own account is read as the parent, or with no entity at all.
    for (const entity of [null, PARENT]) {
      const r = await call<Envelope>(
        'GET',
        `/accounts/${OPERATIONAL}/statements?year=${year}&month=${month}${entity ? `&entity_id=${entity}` : ''}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.data.account_holder).toBe('WAWU operational');
    }
  });

  it('is served through the seam: listTransactions pages the same lines newest first', async () => {
    const holder = { kind: 'customer' as const, customerId: ada.entity };
    const all = (await allLines(ada, 100)).flatMap((p) => p.transactions);
    const seen: string[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const r = await area.listTransactions(holder, { page, take: 50 });
      seen.push(...r.items.map((t) => t.id));
      if (!r.hasNextPage) break;
    }
    expect(seen.length).toBe(all.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(all.map((l) => l.transaction_id).sort());
  });
});
