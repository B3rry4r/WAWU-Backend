import { envelope, errorBody, type NuvionStandin } from './nuvion-standin';

/**
 * NUV-04's routes on the Nuvion stand-in (NUV-01's `NuvionStandin`, through
 * its `on(...)`), from Nuvion's own examples
 * (`nuvion/docs/api-reference__accounts.md`, `api-reference__account-details.md`,
 * `api-reference__transfers.md`, `webhooks__event-types.md`): accounts with
 * a balance, account details that are `pending` until `activate`, and
 * transfers (inflows) to read back. Each route answers only for the entity
 * that owns the record (`entity_id`), as a child entity's call must name
 * it; any other entity gets Nuvion's `error_resource_not_found`.
 */

export interface StandinAccount {
  id: string;
  entity_id: string;
  type: string;
  currency: string;
  display_name: string;
  nuvion_ban: string;
  balance: { available: unknown; current?: unknown; overdraft_used: number };
  deleted: number;
  created: number;
  updated: number;
}

export interface StandinDetails {
  id: string;
  entity_id: string;
  account_id: string;
  issuer: Record<string, unknown>;
  status: string;
  asset_type: string;
  beneficiary_name: string;
  currency: string;
  account_number?: string;
  status_reason?: string;
  deleted: number;
  created: number;
  updated: number;
}

export type StandinTransfer = Record<string, unknown> & {
  id: string;
  entity_id: string;
};

const notFound = () => ({
  status: 404,
  body: errorBody('error_resource_not_found', 'Resource does not exist'),
});

let seq = 0;
/** A ULID-shaped id, unique in this process. */
export function standinId(prefix: string): string {
  seq += 1;
  const tail = `${Date.now().toString(36)}${seq.toString(36)}`.toUpperCase();
  return `${prefix}${tail}`.padEnd(26, '0').slice(0, 26);
}

export class NuvionAccountsStandin {
  readonly accounts = new Map<string, StandinAccount>();
  readonly details = new Map<string, StandinDetails>();
  readonly transfers = new Map<string, StandinTransfer>();
  /** `POST /account-details` bodies, in order. */
  readonly detailRequests: unknown[] = [];

  constructor(readonly standin: NuvionStandin) {}

  /** A naira checking account for an entity (POST /accounts's example shape). */
  addAccount(
    entityId: string,
    over: Partial<StandinAccount> = {},
  ): StandinAccount {
    const a: StandinAccount = {
      id: standinId('01ACC'),
      entity_id: entityId,
      type: 'checking',
      currency: 'NGN',
      display_name: 'Main NGN Account',
      nuvion_ban: `00${String(Date.now()).slice(-8)}`,
      balance: { available: 0, current: 0, overdraft_used: 0 },
      deleted: 0,
      created: Date.now(),
      updated: Date.now(),
      ...over,
    };
    this.accounts.set(a.id, a);
    return a;
  }

  /** Makes an account's details `active` with this number (as Nuvion does later). */
  activate(
    detailsId: string,
    accountNumber: string,
    issuer: Record<string, unknown> = {
      id: '000000000000000000000NG001',
      name: 'Nuvion MFB',
      code: '090999',
      scheme: 'cbn_bank_code',
    },
  ): StandinDetails {
    const d = this.details.get(detailsId);
    if (!d) throw new Error('no such details');
    d.status = 'active';
    d.account_number = accountNumber;
    d.issuer = issuer;
    d.status_reason = 'Account request approved';
    d.updated = Date.now();
    return d;
  }

  /** An inflow as `inflows.completed` carries it (webhooks__event-types.md). */
  addInflow(
    account: StandinAccount,
    over: Partial<StandinTransfer> = {},
  ): StandinTransfer {
    const id = standinId('01TRF');
    const t: StandinTransfer = {
      id,
      amount: 250_000,
      currency: 'NGN',
      unique_reference: `${id}-${Date.now()}`,
      counterparty_id: standinId('01CPY'),
      account_id: account.id,
      entity_id: account.entity_id,
      status: 'successful',
      status_reason: 'Successful.',
      narration: 'Top up from my bank',
      type: 'inflow',
      payment_type: 'bank-transfer',
      applicable_fee: 0,
      meta: {},
      account: { id: account.id, display_name: account.display_name },
      created: Date.now(),
      updated: Date.now(),
      ...over,
    };
    this.transfers.set(t.id, t);
    return t;
  }

  install(): this {
    const s = this.standin;
    s.on('GET', '/accounts', (req) => {
      const rows = [...this.accounts.values()].filter(
        (a) => a.entity_id === req.query.entity_id,
      );
      return {
        status: 200,
        body: envelope(
          {
            data: rows,
            meta: {
              pagination: {
                order: 'desc',
                has_next: false,
                limit: Number(req.query.limit ?? 20),
                has_previous: false,
                next_cursor: null,
                previous_cursor: null,
              },
            },
          },
          'Accounts retrieved successfully',
        ),
      };
    });
    s.on('GET', /^\/accounts\/[A-Za-z0-9]+$/, (req) => {
      const a = this.accounts.get(req.path.split('/')[2]);
      if (!a || a.entity_id !== req.query.entity_id) return notFound();
      return {
        status: 200,
        body: envelope(
          {
            account: a,
            entity: {
              id: a.entity_id,
              type: 'individual',
              verification_status: 'approved',
            },
            account_details: [],
          },
          'Account retrieved successfully',
        ),
      };
    });
    s.on('POST', '/account-details', (req) => {
      this.detailRequests.push(req.body);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const a = this.accounts.get(String(b.account_id));
      if (!a || a.entity_id !== b.entity_id) return notFound();
      if ([...this.details.values()].some((d) => d.account_id === a.id)) {
        return {
          status: 409,
          body: errorBody(
            'error_duplicate_resource',
            'Account details already exist for this account',
          ),
        };
      }
      const d: StandinDetails = {
        id: standinId('01DET'),
        entity_id: a.entity_id,
        account_id: a.id,
        issuer: { name: 'NUV', short_name: 'NUV', code: 'NUV' },
        status: 'pending',
        asset_type: 'fiat',
        beneficiary_name: 'Ada Lovelace',
        currency: a.currency,
        deleted: 0,
        created: Date.now(),
        updated: Date.now(),
      };
      this.details.set(d.id, d);
      return {
        status: 201,
        body: envelope(
          { account_details: d },
          'Account detail created successfully',
        ),
      };
    });
    s.on('GET', '/account-details', (req) => {
      const rows = [...this.details.values()].filter(
        (d) =>
          d.entity_id === req.query.entity_id &&
          (!req.query.account_id || d.account_id === req.query.account_id),
      );
      return {
        status: 200,
        body: envelope(
          {
            data: rows,
            meta: {
              pagination: {
                limit: 20,
                total_count: rows.length,
                has_next: false,
                has_previous: false,
                next_cursor: null,
                previous_cursor: null,
              },
            },
          },
          'Account details retrieved successfully',
        ),
      };
    });
    s.on('GET', /^\/account-details\/[A-Za-z0-9]+$/, (req) => {
      const d = this.details.get(req.path.split('/')[2]);
      if (!d || d.entity_id !== req.query.entity_id) return notFound();
      return {
        status: 200,
        body: envelope(
          { account_detail: d },
          'Account detail retrieved successfully',
        ),
      };
    });
    s.on('GET', /^\/transfers\/[A-Za-z0-9]+$/, (req) => {
      const t = this.transfers.get(req.path.split('/')[2]);
      if (!t || t.entity_id !== req.query.entity_id) return notFound();
      return {
        status: 200,
        body: envelope(t, 'Transfer retrieved successfully'),
      };
    });
    return this;
  }
}
