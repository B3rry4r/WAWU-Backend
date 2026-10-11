import { randomBytes } from 'node:crypto';
import {
  type NuvionAccountsStandin,
  type StandinAccount,
  type StandinTransfer,
  standinId,
} from './accounts-standin';
import {
  envelope,
  errorBody,
  type NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from './nuvion-standin';

/**
 * NUV-06's routes on the Nuvion stand-in (NUV-01's `NuvionStandin`, over
 * NUV-04's accounts and transfers): the bank list, the account name check,
 * counterparties, payment details and NIP transfers, from Nuvion's own
 * examples (`nuvion/docs/guides__send-a-payout.md`,
 * `api-reference__bank-codes.md`, `api-reference__counterparties.md`,
 * `api-reference__payment-details.md`, `api-reference__transfers.md`,
 * `webhooks__event-types.md`, `errors.md`).
 *
 * One thing is NOT from the docs and is flagged wherever it is used: the
 * name check (`POST /counterparty-lookups`) is not in Nuvion's public docs
 * (R-39 names it from Nuvion's dashboard code; the docs list only its
 * `error_resolution_*` errors). Its request body (`country`,
 * `account_number`, `bank_code`) is the task's own words and its answer
 * (`account_name`) is a guess, both to be settled by the sandbox.
 *
 * What it models of Nuvion, each from the docs:
 * - a transfer accepted is `pending`; its funds leave `available` at once
 *   and come back if it fails; a reversal is a credit record
 *   (`outflows.refunded`, `type: inflow`, `meta.source_payment_id`);
 * - a repeated `unique_reference` (per source account) returns the original
 *   transfer instead of making another ("Resubmitting the same reference
 *   returns the original transfer rather than creating a duplicate");
 * - a reference whose first request is still being processed answers
 *   `error_transfer_already_processing` (409);
 * - `GET /transfers` lists newest first with `pagination.order: desc`.
 *
 * Switches, each for the next matching request only: `loseAnswerNext()`
 * (the transfer is made, the connection is cut before the answer),
 * `loseRequestNext()` (cut before the transfer is made), `processingNext
 * (reference)`, `failNext(path, type)`.
 */

/** WAWU's parent entity: the authenticating entity when a call names none. */
export const PARENT_ENTITY = '01HXYZPARENTENTITY0000001';

/** The Fintava-era and Nuvion codes the stand-in's bank list holds. */
export const PAYOUT_BANKS = [
  { bank_code: '044', bank_name: 'Access Bank', swift_bic: 'ABNGNGLA' },
  { bank_code: '058', bank_name: 'Guaranty Trust Bank', swift_bic: 'GTBINGLA' },
  { bank_code: '090270', bank_name: 'AB Microfinance Bank', swift_bic: null },
  { bank_code: '120001', bank_name: '9 Payment Service Bank', swift_bic: null },
  { bank_code: '000014', bank_name: 'Zenith Bank', swift_bic: 'ZEIBNGLA' },
];

interface PagedQuery {
  limit: number;
  cursor: string | null;
}

function paged<T extends { id: string }>(
  rows: T[],
  q: PagedQuery,
  order: 'asc' | 'desc',
) {
  const start = q.cursor ? rows.findIndex((r) => r.id === q.cursor) + 1 : 0;
  const page = rows.slice(start, start + q.limit);
  const hasNext = start + q.limit < rows.length;
  return {
    data: page,
    meta: {
      pagination: {
        order,
        has_next: hasNext,
        limit: q.limit,
        has_previous: start > 0,
        next_cursor: hasNext ? page[page.length - 1].id : null,
        previous_cursor: start > 0 ? rows[start - 1].id : null,
      },
    },
  };
}

/** A body field as text: a string or a number as it is, anything else as the default. */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
}

const notFound = (): StandinAnswer => ({
  status: 404,
  body: errorBody('error_resource_not_found', 'Resource does not exist'),
});

export interface StandinCounterparty {
  id: string;
  entity_id: string;
  type: string;
  nickname: string;
  status: 'active' | 'inactive';
  profile: Record<string, unknown>;
  meta: Record<string, string>;
  created: number;
  updated: number;
  deleted: number;
}

export interface StandinPaymentDetail {
  id: string;
  payment_method: string;
  currency: string;
  account_holder_name: string;
  counterparty_id: string;
  entity_id: string;
  country: string;
  bank_code: string;
  account_number: string;
  bank_name: string;
  deleted: number;
}

export class NuvionPayoutsStandin {
  banks = PAYOUT_BANKS.map((b) => ({ ...b }));
  /** `bank_code:account_number` to the holder's name, for the name check. */
  readonly directory = new Map<string, string>();
  readonly counterparties = new Map<string, StandinCounterparty>();
  readonly paymentDetails = new Map<string, StandinPaymentDetail>();
  /** The bodies of the requests that make things, in order. */
  readonly lookups: unknown[] = [];
  readonly counterpartyRequests: unknown[] = [];
  readonly paymentDetailRequests: unknown[] = [];
  readonly transferRequests: unknown[] = [];
  /** Nuvion's charge on a NIP send, kobo. Deliberately not a real figure. */
  fee = 2345;
  /** References whose next POST answers "already processing". */
  private processing = new Set<string>();
  private seq = 0;
  private loseRequest = 0;
  private overrides: Array<{
    match: RegExp;
    method: string | null;
    what:
      | 'lose_after'
      | { answer: StandinAnswer }
      | { error: { type: string; status?: number } };
  }> = [];
  readonly operational: StandinAccount;

  constructor(
    readonly standin: NuvionStandin,
    readonly nuv: NuvionAccountsStandin,
    readonly operationalAccountId = '01HXYZOPERATIONAL000000001',
  ) {
    this.operational = nuv.addAccount(PARENT_ENTITY, {
      id: operationalAccountId,
      type: 'operational',
      display_name: 'WAWU operational',
      nuvion_ban: 'NVXOPS0001',
      balance: {
        available: 100_000_000,
        current: 100_000_000,
        overdraft_used: 0,
      },
    });
  }

  /** A bank account the name check finds. */
  addAccountAtBank(bankCode: string, number: string, holder: string): void {
    this.directory.set(`${bankCode}:${number}`, holder);
  }

  /** The next request whose path matches answers this documented error (at `status`, else the guessed one). */
  failNext(pathPattern: RegExp, type: string, status?: number): this {
    this.overrides.push({
      match: pathPattern,
      method: null,
      what: { error: { type, status } },
    });
    return this;
  }

  /** The next request of `method` whose path matches answers exactly this. */
  answerNext(method: string, pathPattern: RegExp, answer: StandinAnswer): this {
    this.overrides.push({ match: pathPattern, method, what: { answer } });
    return this;
  }

  /**
   * The next request of `method` whose path matches is made, and the
   * connection is cut before it answers: a lost answer.
   */
  loseAnswerOn(method: string, pathPattern: RegExp): this {
    this.overrides.push({ match: pathPattern, method, what: 'lose_after' });
    return this;
  }

  /** The next `POST /transfers` is made, and the connection is cut before it answers. */
  loseAnswerNext(times = 1): this {
    for (let i = 0; i < times; i += 1) {
      this.loseAnswerOn('POST', /^\/transfers$/);
    }
    return this;
  }

  /** The next `POST /transfers` is cut before it is made. */
  loseRequestNext(times = 1): this {
    this.loseRequest += times;
    return this;
  }

  /** The next `POST /transfers` with this reference answers "already processing". */
  processingNext(reference: string): this {
    this.processing.add(reference);
    return this;
  }

  /** A transfer of this stand-in, by id. */
  transfer(id: string): StandinTransfer {
    const t = this.nuv.transfers.get(id);
    if (!t) throw new Error(`no such transfer ${id}`);
    return t;
  }

  /** Makes a transfer older (or newer) by `ms`, for a walk back in time. */
  age(id: string, ms: number): void {
    const t = this.transfer(id);
    t.created = Number(t.created) - ms;
  }

  /** The transfers a reference made. */
  byReference(reference: string): StandinTransfer[] {
    return [...this.nuv.transfers.values()].filter(
      (t) => t.unique_reference === reference,
    );
  }

  /** Nuvion finishes a transfer: funds settle, or come back. */
  settle(
    id: string,
    status: 'processing' | 'successful' | 'failed',
    reason?: string,
  ): StandinTransfer {
    const t = this.transfer(id);
    const account = this.nuv.accounts.get(String(t.account_id))!;
    const total = Number(t.amount) + Number(t.applicable_fee);
    if (status === 'failed' && t.status !== 'failed') {
      this.bump(account, 'available', total);
    }
    if (status === 'successful' && t.status !== 'successful') {
      this.bump(account, 'current', -total);
    }
    t.status = status;
    t.status_reason =
      reason ??
      (status === 'successful'
        ? 'processing_complete'
        : status === 'failed'
          ? 'invalid_account_details'
          : 'processing');
    t.updated = Date.now();
    return t;
  }

  /** A completed transfer comes back: the money returns and a credit record is made. */
  reverse(id: string): { original: StandinTransfer; credit: StandinTransfer } {
    const t = this.transfer(id);
    const account = this.nuv.accounts.get(String(t.account_id))!;
    const total = Number(t.amount) + Number(t.applicable_fee);
    this.bump(account, 'available', total);
    this.bump(account, 'current', total);
    t.status = 'reversed';
    t.status_reason = 'bank_returned';
    t.updated = Date.now();
    const cid = standinId('01CRD');
    const credit: StandinTransfer = {
      id: cid,
      entity_id: t.entity_id,
      account_id: t.account_id,
      amount: t.amount,
      currency: t.currency,
      unique_reference: `${str(t.unique_reference)}_reversal`,
      counterparty_id: `acct-${str(t.account_id)}-bank-return`,
      status: 'successful',
      status_reason: 'bank_returned',
      narration: `REVERSAL | ${t.id}`,
      type: 'inflow',
      payment_type: 'bank-transfer',
      applicable_fee: 0,
      meta: { source: 'bank_return', source_payment_id: t.id },
      created: Date.now(),
      updated: Date.now(),
    };
    this.nuv.transfers.set(cid, credit);
    return { original: t, credit };
  }

  /** The transfer as a webhook delivers it (`data`). */
  delivery(id: string): Record<string, unknown> {
    const t = this.transfer(id);
    const account = this.nuv.accounts.get(String(t.account_id));
    return {
      ...t,
      account: account
        ? { id: account.id, display_name: account.display_name }
        : undefined,
    };
  }

  private bump(a: StandinAccount, key: 'available' | 'current', by: number) {
    a.balance = { ...a.balance, [key]: Number(a.balance[key]) + by };
  }

  /** The override for this request, taken (once), or null. */
  private take(req: StandinRequest) {
    const i = this.overrides.findIndex(
      (o) =>
        o.match.test(req.path) &&
        (o.method === null || o.method === req.method),
    );
    return i < 0 ? null : this.overrides.splice(i, 1)[0];
  }

  /** The documented error as an answer; its status is the page's, or `status`. */
  private errorAnswer(type: string, status?: number): StandinAnswer {
    const guessed = type.includes('timeout')
      ? 504
      : type.includes('unavailable')
        ? 503
        : type.includes('not_found')
          ? 404
          : type.includes('already') || type.includes('duplicate')
            ? 409
            : type.includes('insufficient') ||
                type.includes('limit') ||
                type.includes('cutoff')
              ? 400
              : 422;
    return {
      status: status ?? guessed,
      body: errorBody(type, 'Something went wrong.'),
    };
  }

  /** Runs a route, unless an override changes what this request gets. */
  private route(
    method: string,
    path: string | RegExp,
    handler: (req: StandinRequest) => StandinAnswer,
  ): void {
    this.standin.on(method, path, (req) => {
      const o = this.take(req);
      if (o === null) return handler(req);
      if (o.what === 'lose_after') {
        handler(req);
        return { status: 0, hangUp: true };
      }
      if ('answer' in o.what) return o.what.answer;
      return this.errorAnswer(o.what.error.type, o.what.error.status);
    });
  }

  install(): this {
    const entityOf = (req: StandinRequest) =>
      req.query.entity_id ?? PARENT_ENTITY;
    const limitOf = (req: StandinRequest) =>
      Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));

    this.route('GET', /^\/bank-codes\/[A-Z]{2}$/, (req) => ({
      status: 200,
      body: envelope(
        req.path.endsWith('/NG') ? this.banks : [],
        'Bank codes retrieved successfully',
      ),
    }));

    // The name check: NOT in Nuvion's public docs (see the file comment).
    this.route('POST', '/counterparty-lookups', (req) => {
      this.lookups.push(req.body);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const number = str(b.account_number);
      const code = str(b.bank_code);
      if (b.country !== 'NG' || !/^\d{10}$/.test(number)) {
        return {
          status: 422,
          body: errorBody(
            'error_resolution_format_invalid',
            'Account number format is invalid',
          ),
        };
      }
      if (!this.banks.some((x) => x.bank_code === code)) {
        return {
          status: 422,
          body: errorBody(
            'error_resolution_bank_not_supported',
            'Account lookups are not supported for this bank',
          ),
        };
      }
      const holder = this.directory.get(`${code}:${number}`);
      if (!holder) {
        return {
          status: 404,
          body: errorBody(
            'error_resolution_account_not_found',
            'No account found matching the provided details',
          ),
        };
      }
      return {
        status: 200,
        body: envelope(
          { account_name: holder, account_number: number, bank_code: code },
          'Account resolved successfully',
        ),
      };
    });

    this.route('POST', '/counterparties', (req) => {
      this.counterpartyRequests.push(req.body);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const profile = (b.profile ?? {}) as Record<string, unknown>;
      if (b.type !== 'individual' && b.type !== 'business') {
        return {
          status: 422,
          body: errorBody('error_validation_error', 'type is required'),
        };
      }
      const entityId = str(b.entity_id, PARENT_ENTITY);
      const c: StandinCounterparty = {
        id: standinId('01CPY'),
        entity_id: entityId,
        type: str(b.type),
        nickname: `${str(profile.first_name)} ${str(profile.last_name)}`.trim(),
        status: 'active',
        profile,
        meta: (b.meta ?? {}) as Record<string, string>,
        created: Date.now(),
        updated: Date.now(),
        deleted: 0,
      };
      this.counterparties.set(c.id, c);
      return {
        status: 201,
        body: envelope(c, 'Counterparty created successfully'),
      };
    });

    this.route('GET', '/counterparties', (req) => {
      const rows = [...this.counterparties.values()].filter(
        (c) =>
          c.entity_id === entityOf(req) &&
          (!req.query.status || c.status === req.query.status),
      );
      return {
        status: 200,
        body: envelope(
          paged(
            rows,
            { limit: limitOf(req), cursor: req.query.cursor ?? null },
            'asc',
          ),
          'Counterparties retrieved successfully',
        ),
      };
    });

    this.route('POST', '/payment-details', (req) => {
      this.paymentDetailRequests.push(req.body);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const c = this.counterparties.get(str(b.counterparty_id));
      const entityId = str(b.entity_id, PARENT_ENTITY);
      if (!c || c.entity_id !== entityId) return notFound();
      if (
        b.payment_method !== 'bank-transfer' ||
        b.currency !== 'NGN' ||
        b.country !== 'NG' ||
        !/^\d{10}$/.test(str(b.account_number)) ||
        !b.bank_code ||
        !b.account_holder_name ||
        !b.bank_name
      ) {
        return {
          status: 422,
          body: errorBody(
            'error_validation_error',
            'A required field is missing',
          ),
        };
      }
      const d: StandinPaymentDetail = {
        id: standinId('01PDT'),
        payment_method: 'bank-transfer',
        currency: 'NGN',
        account_holder_name: str(b.account_holder_name),
        counterparty_id: c.id,
        entity_id: entityId,
        country: 'NG',
        bank_code: str(b.bank_code),
        account_number: str(b.account_number),
        bank_name: str(b.bank_name),
        deleted: 0,
      };
      this.paymentDetails.set(d.id, d);
      return {
        status: 201,
        body: envelope(d, 'Payment detail created successfully'),
      };
    });

    this.route('GET', /^\/payment-details\/[A-Za-z0-9]+$/, (req) => {
      const d = this.paymentDetails.get(req.path.split('/')[2]);
      if (!d || d.entity_id !== entityOf(req)) return notFound();
      return {
        status: 200,
        body: envelope(d, 'Payment detail retrieved successfully'),
      };
    });

    this.route(
      'GET',
      /^\/counterparties\/[A-Za-z0-9]+\/payment-details$/,
      (req) => {
        const id = req.path.split('/')[2];
        const rows = [...this.paymentDetails.values()].filter(
          (d) => d.counterparty_id === id && d.entity_id === entityOf(req),
        );
        return {
          status: 200,
          body: envelope(
            paged(
              rows,
              { limit: limitOf(req), cursor: req.query.cursor ?? null },
              'asc',
            ),
            'Payment details retrieved successfully',
          ),
        };
      },
    );

    // An account read with no `entity_id` is the authenticating (parent)
    // entity's; NUV-04's route answers only a named child entity.
    this.route('GET', /^\/accounts\/[A-Za-z0-9]+$/, (req) => {
      const a = this.nuv.accounts.get(req.path.split('/')[2]);
      if (!a || a.entity_id !== entityOf(req)) return notFound();
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

    this.route('GET', /^\/transfers\/[A-Za-z0-9]+$/, (req) => {
      const t = this.nuv.transfers.get(req.path.split('/')[2]);
      if (!t || t.entity_id !== entityOf(req)) return notFound();
      return {
        status: 200,
        body: envelope(t, 'Transfer retrieved successfully'),
      };
    });

    this.route('GET', '/transfers', (req) => {
      const rows = [...this.nuv.transfers.values()]
        .filter(
          (t) =>
            t.entity_id === entityOf(req) &&
            (!req.query.account_id || t.account_id === req.query.account_id) &&
            (!req.query.status || t.status === req.query.status),
        )
        .sort((a, b) => Number(b.created) - Number(a.created));
      return {
        status: 200,
        body: envelope(
          paged(
            rows,
            { limit: limitOf(req), cursor: req.query.cursor ?? null },
            'desc',
          ),
          'Transfers retrieved successfully',
        ),
      };
    });

    this.route('POST', '/transfers', (req) => {
      this.transferRequests.push(req.body);
      if (this.loseRequest > 0) {
        this.loseRequest -= 1;
        return { status: 0, hangUp: true };
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const reference = str(b.unique_reference);
      if (this.processing.delete(reference)) {
        return {
          status: 409,
          body: errorBody(
            'error_transfer_already_processing',
            'A transfer with this reference is being processed',
          ),
        };
      }
      const account = this.nuv.accounts.get(str(b.account_id));
      const entityId = str(b.entity_id, PARENT_ENTITY);
      if (!account || account.entity_id !== entityId) return notFound();
      const detail = this.paymentDetails.get(str(b.payment_detail_id));
      const counterparty = this.counterparties.get(str(b.counterparty_id));
      if (
        !detail ||
        !counterparty ||
        detail.entity_id !== entityId ||
        detail.counterparty_id !== counterparty.id
      ) {
        return notFound();
      }
      // A repeated reference (per source account) returns the original.
      const original = [...this.nuv.transfers.values()].find(
        (t) =>
          t.account_id === account.id &&
          t.unique_reference === reference &&
          t.type === 'outflow',
      );
      const answer = (t: StandinTransfer): StandinAnswer => ({
        status: 201,
        body: envelope(t, 'Transfer created successfully'),
      });
      if (original) return answer(original);
      const amount = Number(b.amount);
      if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        b.currency !== account.currency ||
        b.payment_type !== 'bank-transfer'
      ) {
        return {
          status: 422,
          body: errorBody('error_validation_error', 'A field is invalid'),
        };
      }
      if (Number(account.balance.available) < amount + this.fee) {
        return {
          status: 400,
          body: errorBody(
            'error_transfer_insufficient_funds',
            'Insufficient funds in the source account',
          ),
        };
      }
      const t: StandinTransfer = {
        id: standinId('01TRF'),
        amount,
        currency: str(b.currency),
        unique_reference: reference,
        counterparty_id: counterparty.id,
        payment_detail_id: detail.id,
        account_id: account.id,
        entity_id: entityId,
        status: 'pending',
        status_reason: 'awaiting_processing',
        narration: b.narration ?? null,
        type: 'outflow',
        payment_type: 'bank-transfer',
        applicable_fee: this.fee,
        meta: {},
        created: Date.now() + (this.seq += 1),
        updated: Date.now(),
      };
      this.nuv.transfers.set(t.id, t);
      this.bump(account, 'available', -(amount + this.fee));
      return answer(t);
    });

    return this;
  }

  /** A signed-delivery-ready event id. */
  eventId(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString('hex')}`;
  }
}
