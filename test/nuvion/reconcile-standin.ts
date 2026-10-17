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
 * account's statement, the webhook subscription and fee simulations. Built
 * on the transfers the accounts stand-in (inflows, payouts) and the book
 * stand-in (book transfers) already hold, so a statement and
 * `GET /transfers/{id}` always agree.
 *
 * THE SHAPES ARE AN ASSUMPTION (see src/nuvion/areas/reconcile-readers.ts):
 * the saved copy of Nuvion's docs was not on the machine this was built on.
 * A statement is a cursor list of lines
 * `{ id, transfer_id, type, amount, applicable_fee, balance_after, status,
 * currency, payment_type, unique_reference, narration, created, account_id,
 * entity_id }`, one calendar month a call (`year`, `month`), pending lines
 * only with `include_pending=true`, oldest first. A subscription is
 * `{ id, url, enabled_events, status, expires_in, expires_at, created }`.
 * A fee simulation answers `{ applicable_fee }`.
 */

export interface StandinSubscription {
  id: string;
  url: string;
  enabled_events: string[];
  status: 'active' | 'inactive';
  expires_in: number;
  expires_at: number;
  created: number;
}

interface Row {
  transferId: string;
  accountId: string;
  entityId: string | null;
  type: 'inflow' | 'outflow';
  amount: number;
  fee: number;
  status: string;
  paymentType: string | null;
  reference: string | null;
  narration: string | null;
  created: number;
}

export class NuvionReconcileStandin {
  readonly subscriptions = new Map<string, StandinSubscription>();
  /** Every `POST /fee-simulations` body, in order. */
  readonly simulations: Array<Record<string, unknown>> = [];
  /** Every `PATCH /entity-webhooks/{id}` body, in order. */
  readonly renewals: Array<Record<string, unknown>> = [];
  /** Statement requests, as asked. */
  readonly statementRequests: Array<Record<string, string>> = [];
  /** What Nuvion would charge, by kind, for the simulation. */
  simulatedFee: (input: {
    type: string;
    payment_type: string;
    amount: number;
  }) => number = () => 0;
  /** Renewals answer an error until this is false. */
  failRenewals = false;
  /** Renewals answer 200 but leave the expiry where it was. */
  renewalsDoNothing = false;
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
      enabled_events: ['inflows.completed', 'outflows.completed'],
      status: 'active',
      expires_in: 30 * 86_400,
      expires_at: now + 30 * 86_400_000,
      created: now,
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
        entityId: t.entity_id ?? null,
        type: t.type === 'inflow' ? 'inflow' : 'outflow',
        amount: t.amount as number,
        fee: (t.applicable_fee as number | undefined) ?? 0,
        status: String(t.status),
        paymentType: (t.payment_type as string | undefined) ?? null,
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
        entityId: b.entity_id ?? null,
        type: 'outflow',
        amount: b.amount,
        fee: b.applicable_fee ?? 0,
        status: String(b.status),
        paymentType: 'book-transfer',
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
      const inMonth = this.rowsOf(id).filter((r) => {
        const d = new Date(r.created);
        return (
          d.getUTCFullYear() === year &&
          d.getUTCMonth() + 1 === month &&
          (wantPending || (r.status !== 'pending' && r.status !== 'processing'))
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
            data: page.map((r) => ({
              id: `LINE${r.transferId}`.slice(0, 26),
              transfer_id: r.transferId,
              account_id: r.accountId,
              entity_id: r.entityId,
              type: r.type,
              amount: r.amount,
              applicable_fee: r.fee,
              balance_after: r.balance,
              status: r.status,
              currency: 'NGN',
              payment_type: r.paymentType,
              unique_reference: r.reference,
              narration: r.narration,
              created: r.created,
            })),
            meta: {
              pagination: {
                order: 'asc',
                has_next: hasNext,
                has_previous: start > 0,
                limit,
                next_cursor: hasNext ? page[page.length - 1].transferId : null,
                previous_cursor:
                  start > 0 ? inMonth[start - 1].transferId : null,
              },
            },
          },
          'Statement retrieved successfully',
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
    s.on('PATCH', /^\/entity-webhooks\/[A-Za-z0-9]+$/, (req): StandinAnswer => {
      const sub = this.subscriptions.get(req.path.split('/')[2]);
      if (!sub) return notFound();
      this.renewals.push((req.body ?? {}) as Record<string, unknown>);
      if (this.failRenewals) {
        return {
          status: 500,
          body: errorBody('error_internal_server', 'Something went wrong.'),
        };
      }
      const inSeconds = Number(
        (req.body as { expires_in?: unknown })?.expires_in,
      );
      if (!this.renewalsDoNothing && Number.isFinite(inSeconds)) {
        sub.expires_in = inSeconds;
        sub.expires_at = Date.now() + inSeconds * 1000;
      }
      return {
        status: 200,
        body: envelope(sub, 'Webhook updated successfully'),
      };
    });
    s.on('POST', '/fee-simulations', (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      this.simulations.push(b);
      return {
        status: 200,
        body: envelope(
          {
            applicable_fee: this.simulatedFee({
              type: String(b.type),
              payment_type: String(b.payment_type),
              amount: Number(b.amount),
            }),
          },
          'Fee simulated successfully',
        ),
      };
    });
    return this;
  }
}

function notFound(): StandinAnswer {
  return {
    status: 404,
    body: errorBody('error_resource_not_found', 'Resource does not exist'),
  };
}
