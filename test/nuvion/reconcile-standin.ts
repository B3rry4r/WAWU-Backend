import type { NuvionAccountsStandin } from './accounts-standin';
import { standinId } from './accounts-standin';
import type { NuvionBookStandin } from './book-standin';
import {
  envelope,
  errorBody,
  type NuvionStandin,
  type StandinAnswer,
} from './nuvion-standin';

/**
 * Nuvion's reconciliation routes on the NUV-01 stand-in (task NUV-08): an
 * account's statement and the webhook subscriptions. Built on the transfers
 * the accounts stand-in (inflows, payouts) and the book stand-in (book
 * transfers) already hold, so a statement and `GET /transfers/{id}` always
 * agree.
 *
 * THE SHAPES ARE NUVION'S PUBLIC DOCS (round 2; api-reference__accounts.md,
 * "Get account statements", and api-reference__webhooks.md, "The Webhook
 * object"). A statement is `{ account_id, ..., transactions: [...],
 * pagination: {...} }` under `data`, one calendar month a call (`year`,
 * `month`), pending lines only with `include_pending=true`, oldest first;
 * each line is `{ transaction_id, date (ISO), type (credit|debit),
 * description, counterparty, amount, fee, net_amount, running_balance,
 * reference, status (completed|pending), currency }`. A subscription is
 * `{ id, entity_id, url, expires_in, enabled_events (an object), status
 * (active|inactive), created, updated, deleted, stats }`. There is NO
 * fee-simulation route and NO way to renew a subscription, because the docs
 * show none: a call to one reaches nothing, and the specs assert none is made.
 */

export interface StandinSubscription {
  id: string;
  entity_id: string;
  url: string;
  expires_in: number;
  enabled_events: Record<string, unknown>;
  preferred_events: string[];
  status: 'active' | 'inactive';
  created: number;
  updated: number;
  deleted: number;
}

interface Row {
  transferId: string;
  accountId: string;
  type: 'inflow' | 'outflow';
  amount: number;
  fee: number;
  status: string;
  reference: string | null;
  narration: string | null;
  created: number;
}

export class NuvionReconcileStandin {
  readonly subscriptions = new Map<string, StandinSubscription>();
  /** Statement requests, as asked. */
  readonly statementRequests: Array<Record<string, string>> = [];
  /** Lines of a statement a page serves, whatever `limit` asks (to force many pages). */
  pageCap: number | null = null;

  constructor(
    readonly standin: NuvionStandin,
    readonly accounts: NuvionAccountsStandin,
    readonly book: NuvionBookStandin | null = null,
  ) {}

  /** A subscription as `GET /entity-webhooks` lists it. */
  addSubscription(
    over: Partial<StandinSubscription> = {},
  ): StandinSubscription {
    const now = Date.now();
    const s: StandinSubscription = {
      id: standinId('01WHK'),
      url: 'https://api.example.test/api/hub/webhooks/nuvion',
      entity_id: standinId('01ENT'),
      enabled_events: {
        all: false,
        inflows: { completed: true, failed: true },
        outflows: { created: true, completed: true, failed: true },
      },
      preferred_events: ['inflows.all', 'outflows.all'],
      status: 'active',
      expires_in: 30 * 86_400,
      created: now,
      updated: now,
      deleted: 0,
      ...over,
    };
    this.subscriptions.set(s.id, s);
    return s;
  }

  /** Every movement of one account, oldest first, with its running balance. */
  private rowsOf(accountId: string): Array<Row & { balance: number }> {
    const rows: Row[] = [];
    for (const t of this.accounts.transfers.values()) {
      if (t.account_id !== accountId) continue;
      rows.push({
        transferId: t.id,
        accountId,
        type: t.type === 'inflow' ? 'inflow' : 'outflow',
        amount: t.amount as number,
        fee: (t.applicable_fee as number | undefined) ?? 0,
        status: String(t.status),
        reference: (t.unique_reference as string | undefined) ?? null,
        narration: (t.narration as string | undefined) ?? null,
        created: t.created as number,
      });
    }
    for (const b of this.book?.all() ?? []) {
      if (b.account_id !== accountId) continue;
      rows.push({
        transferId: b.id,
        accountId,
        type: 'outflow',
        amount: b.amount,
        fee: b.applicable_fee ?? 0,
        status: String(b.status),
        reference: b.unique_reference ?? null,
        narration: b.narration,
        created: b.created,
      });
    }
    rows.sort(
      (a, b) => a.created - b.created || (a.transferId < b.transferId ? -1 : 1),
    );
    let balance = 0;
    return rows.map((r) => {
      if (r.status === 'successful') {
        balance += r.type === 'inflow' ? r.amount : -(r.amount + r.fee);
      }
      return { ...r, balance };
    });
  }

  /** The running balance after the last successful movement of an account. */
  balanceOf(accountId: string): number {
    return this.rowsOf(accountId).at(-1)?.balance ?? 0;
  }

  install(): this {
    const s = this.standin;
    s.on('GET', /^\/accounts\/[A-Za-z0-9]+\/statements$/, (req) => {
      this.statementRequests.push(req.query);
      const id = req.path.split('/')[2];
      const a = this.accounts.accounts.get(id);
      const operational = a?.type === 'operational';
      if (
        !a ||
        (operational
          ? req.query.entity_id !== undefined &&
            req.query.entity_id !== a.entity_id
          : a.entity_id !== req.query.entity_id)
      ) {
        return notFound();
      }
      const year = Number(req.query.year);
      const month = Number(req.query.month);
      if (!Number.isInteger(year) || !(month >= 1 && month <= 12)) {
        return {
          status: 400,
          body: errorBody(
            'error_validation_failed',
            'year and month are required',
          ),
        };
      }
      const wantPending = req.query.include_pending === 'true';
      // The docs show two words for a line, completed and pending; a failed
      // or reversed transfer moved nothing and is not a line.
      const wordOf = (status: string) =>
        status === 'successful'
          ? 'completed'
          : status === 'pending' || status === 'processing'
            ? 'pending'
            : null;
      const inMonth = this.rowsOf(id).filter((r) => {
        const d = new Date(r.created);
        const word = wordOf(r.status);
        return (
          d.getUTCFullYear() === year &&
          d.getUTCMonth() + 1 === month &&
          word !== null &&
          (wantPending || word === 'completed')
        );
      });
      const limit = Math.min(
        this.pageCap ?? 100,
        Math.max(1, Number(req.query.limit ?? 20)),
      );
      const start = req.query.cursor
        ? inMonth.findIndex((r) => r.transferId === req.query.cursor) + 1
        : 0;
      const page = inMonth.slice(start, start + limit);
      const hasNext = start + limit < inMonth.length;
      return {
        status: 200,
        body: envelope(
          {
            account_id: id,
            account_holder: 'Test Holder',
            account_currency: 'NGN',
            ban: a?.nuvion_ban ?? null,
            generated_at: new Date().toISOString(),
            period: {
              start_date: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
              end_date: new Date().toISOString(),
            },
            balances: {
              opening_balance: 0,
              closing_balance: this.balanceOf(id),
              total_credits: 0,
              total_debits: 0,
              total_fees: 0,
            },
            transactions: page.map((r) => ({
              transaction_id: r.transferId,
              date: new Date(r.created).toISOString(),
              type: r.type === 'inflow' ? 'credit' : 'debit',
              description: r.narration ?? 'Transfer',
              counterparty: { name: 'Test counterparty', account_number: null },
              amount: r.amount,
              fee: r.fee,
              net_amount: r.amount - r.fee,
              running_balance: r.balance,
              reference: r.reference ?? r.transferId,
              status: wordOf(r.status),
              currency: 'NGN',
            })),
            pagination: {
              order: 'asc',
              has_next: hasNext,
              has_previous: start > 0,
              limit,
              next_cursor: hasNext ? page[page.length - 1].transferId : null,
              previous_cursor: start > 0 ? inMonth[start - 1].transferId : null,
              total_transactions: inMonth.length,
            },
          },
          'Account statement retrieved successfully',
        ),
      };
    });

    // One `GET /transfers/{id}` for both kinds: an inflow or payout the test
    // added to the accounts stand-in, and a book transfer the book stand-in
    // holds. A child's transfer is read with its `entity_id`, the parent's
    // (WAWU's operational account) without one.
    s.on('GET', /^\/transfers\/[A-Za-z0-9]+$/, (req) => {
      const id = req.path.split('/')[2];
      const parent = this.book?.parentEntityId ?? null;
      const mayRead = (entityId: unknown) =>
        entityId === parent
          ? req.query.entity_id === undefined || req.query.entity_id === parent
          : req.query.entity_id === entityId;
      const own = this.accounts.transfers.get(id);
      const found = own ?? this.book?.all().find((t) => t.id === id);
      if (!found || !mayRead(found.entity_id)) return notFound();
      return {
        status: 200,
        body: envelope(found, 'Transfer retrieved successfully'),
      };
    });

    s.on('GET', '/entity-webhooks', () => ({
      status: 200,
      body: envelope(
        {
          data: [...this.subscriptions.values()],
          meta: {
            pagination: {
              order: 'desc',
              has_next: false,
              has_previous: false,
              limit: 100,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        },
        'Webhooks retrieved successfully',
      ),
    }));
    return this;
  }
}

function notFound(): StandinAnswer {
  return {
    status: 404,
    body: errorBody('error_resource_not_found', 'Resource does not exist'),
  };
}
