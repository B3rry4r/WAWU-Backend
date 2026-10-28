import { randomBytes } from 'node:crypto';
import type { NuvionAccountsStandin } from './accounts-standin';
import {
  envelope,
  errorBody,
  type NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from './nuvion-standin';

/**
 * Nuvion's payment intents and funding sessions as a local stand-in
 * (WALLET-25, WALLET-26), for the add-money specs. Its answers are the shapes
 * Nuvion's docs show (api-reference__payment-intents, guides__funding-session)
 * and the ones read on dev (mobile docs/nuvion/DEV-RESULTS.md, WALLET-25 rows):
 * a payment intent made `requires_action`, confirmed by an intent action that
 * is `completed` at once for the docs' test card, `pending_user_action` with a
 * hosted page for 3-D Secure and Apple Pay, or `failed`; and, on dev, the card
 * inflow on the account is a transfer of `payment_type` `card-acq` carrying the
 * intent's `reference` as its `unique_reference`, `pending` until it settles.
 * Funding sessions answer `awaiting_user` (with a `checkout_url` for the bank
 * checkout) and are `settled`, `failed` or `expired` when a spec says.
 *
 * The inflow's id starts `ADDM`, so its `GET /transfers/{id}` is told apart
 * from the book stand-in's and the accounts stand-in's.
 */
export type CardMode = 'frictionless' | 'threeds' | 'decline' | 'bad_card';

export interface StandinIntent {
  id: string;
  currency: string;
  amount: number;
  reference: string;
  description: string | null;
  status: string;
  status_reason?: string;
  entity_id: string;
  account_id: string;
  created: number;
  intent_action: Record<string, unknown> | null;
}

export interface StandinSession {
  id: string;
  status: string;
  amount: number;
  currency: string;
  account_id: string;
  unique_reference: string;
  funding_type: string;
  entity_id: string;
  narration: string | null;
  checkout_url?: string;
  redirect_url?: string;
  meta?: Record<string, unknown>;
  failure?: { code: string; message: string; failed_at: number };
  expires_at: number | null;
  created: number;
}

const id = (prefix: string) =>
  `${prefix}${randomBytes(10).toString('hex').toUpperCase()}`.slice(0, 26);

/** A request body as the stand-in reads it: only the fields it looks at. */
interface Body {
  payment_intent_id?: string;
  currency?: string;
  amount?: number;
  account_id?: string;
  entity_id?: string;
  unique_reference?: string;
  funding_type?: string;
  narration?: string;
  redirect_url?: string;
  meta?: { msisdn?: string; channel?: string };
  intent_action?: {
    payment_type?: string;
    return_url?: string;
    payment_type_data?: { data?: string; billing_address?: unknown };
  };
}

export class NuvionAddMoneyStandin {
  readonly intents = new Map<string, StandinIntent>();
  readonly sessions = new Map<string, StandinSession>();
  /** Inflows made by a settled payment, by id. */
  readonly inflows = new Map<string, Record<string, unknown>>();
  /** What the next card confirm does. */
  cardMode: CardMode = 'frictionless';
  /** Nuvion's charge on a card payment, in the smallest unit. */
  cardFee = 75;
  /** Dev's answer for naira: cards `error_acquiring_currency_not_supported`, funding sessions 503. */
  refuseNaira = false;
  /**
   * Production (27 Oct 2026): card acquiring is SUSPENDED. The card routes answer 403 `error_acquiring_service_suspended`, and a
   * funding session a 403 `error_auth_permission_denied` whose words say the service is suspended.
   */
  suspended = false;
  /** Every body of POST /intent-actions, for the spec to prove no card text is kept (it is only read here). */
  readonly confirmBodies: unknown[] = [];

  constructor(
    private readonly s: NuvionStandin,
    private readonly accounts: NuvionAccountsStandin,
  ) {}

  install(): this {
    const s = this.s;
    s.on('POST', '/payment-intents', (req) => this.createIntent(req));
    s.on('GET', /^\/payment-intents\/[A-Za-z0-9]+$/, (req) => {
      const i = this.intents.get(req.path.split('/')[2]);
      return i
        ? this.ok(i, 'Payment intent fetched successfully')
        : this.missing();
    });
    s.on('GET', '/payment-intents', (req) => {
      const items = [...this.intents.values()].filter(
        (i) =>
          (!req.query.reference || i.reference === req.query.reference) &&
          (!req.query.account_id || i.account_id === req.query.account_id),
      );
      return this.ok(
        { items, meta: { pagination: {} } },
        'Payment intents fetched successfully',
      );
    });
    s.on('PATCH', /^\/payment-intents\/[A-Za-z0-9]+$/, (req) => {
      const i = this.intents.get(req.path.split('/')[2]);
      if (!i) return this.missing();
      if (i.status !== 'requires_action') {
        return {
          status: 409,
          body: errorBody(
            'error_operation_invalid_for_state',
            'Only an unconfirmed intent can be cancelled.',
          ),
        };
      }
      i.status = 'cancelled';
      i.status_reason = 'Cancelled in the app';
      return this.ok(i, 'Payment intent modified successfully');
    });
    s.on('POST', '/intent-actions', (req) => this.confirm(req));
    s.on('POST', '/funding-sessions', (req) => this.createSession(req));
    s.on('GET', /^\/funding-sessions\/[A-Za-z0-9]+$/, (req) => {
      const x = this.sessions.get(req.path.split('/')[2]);
      return x
        ? this.ok(this.sessionView(x), 'Funding session retrieved successfully')
        : this.missing();
    });
    s.on('GET', '/funding-sessions', (req) => {
      const rows = [...this.sessions.values()]
        .filter(
          (x) => !req.query.account_id || x.account_id === req.query.account_id,
        )
        .map((x) => this.sessionView(x));
      return this.ok(
        {
          data: rows,
          meta: {
            pagination: {
              order: 'desc',
              has_next: false,
              limit: 100,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        },
        'Funding sessions retrieved successfully',
      );
    });
    s.on('GET', /^\/transfers\/ADDM[A-Za-z0-9]+$/, (req) => {
      const t = this.inflows.get(req.path.split('/')[2]);
      return t && t.entity_id === req.query.entity_id
        ? this.ok(t, 'Transfer retrieved successfully')
        : this.missing();
    });
    return this;
  }

  /**
   * The inflow Nuvion records on the account for a payment (`card-acq` for a
   * card or Apple Pay, `open-banking` or `momo` for a funding session), with
   * the payment's reference. `status` is Nuvion's: pending, successful, failed.
   */
  inflowFor(
    reference: string,
    status: 'pending' | 'successful' | 'failed',
    over: { amount?: number; fee?: number; currency?: string } = {},
  ): Record<string, unknown> {
    const intent = [...this.intents.values()].find(
      (i) => i.reference === reference,
    );
    const session = [...this.sessions.values()].find(
      (x) => x.unique_reference === reference,
    );
    const src = intent ?? session;
    if (!src) throw new Error('no payment with that reference');
    const existing = [...this.inflows.values()].find(
      (t) => t.unique_reference === reference,
    );
    const t: Record<string, unknown> = {
      id: existing ? existing.id : id('ADDM'),
      amount: over.amount ?? src.amount,
      currency: over.currency ?? src.currency,
      unique_reference: reference,
      counterparty_id: id('CP'),
      account_id: src.account_id,
      entity_id: src.entity_id,
      status,
      narration: 'Add money',
      type: 'inflow',
      payment_type: intent
        ? (intent.intent_action?.payment_type ?? 'card-acq')
        : session?.funding_type === 'momo'
          ? 'momo'
          : 'open-banking',
      applicable_fee: over.fee ?? (intent ? this.cardFee : 500),
      meta: { source: 'intent-action' },
      created: Date.now(),
      updated: Date.now(),
    };
    this.inflows.set(t.id as string, t);
    if (status === 'successful') {
      const acct = this.accounts.accounts.get(src.account_id);
      if (acct) {
        const net = Number(t.amount) - Number(t.applicable_fee);
        acct.balance.available = Number(acct.balance.available) + net;
        acct.balance.current = Number(acct.balance.current) + net;
      }
    }
    return t;
  }

  setSessionStatus(
    reference: string,
    status: string,
    failureCode?: string,
  ): void {
    const x = [...this.sessions.values()].find(
      (v) => v.unique_reference === reference,
    );
    if (!x) throw new Error('no funding session with that reference');
    x.status = status;
    if (failureCode) {
      x.failure = {
        code: failureCode,
        message: 'Failed',
        failed_at: Date.now(),
      };
    }
  }

  // -------------------------------------------------------------------------

  private ok(data: unknown, message: string): StandinAnswer {
    return { status: 200, body: envelope(data, message) };
  }
  private missing(): StandinAnswer {
    return {
      status: 404,
      body: errorBody('error_resource_not_found', "We couldn't find that."),
    };
  }

  private suspendedCard(): StandinAnswer {
    return {
      status: 403,
      body: errorBody(
        'error_acquiring_service_suspended',
        'Card acquiring is suspended.',
      ),
    };
  }

  private createIntent(req: StandinRequest): StandinAnswer {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (this.suspended) return this.suspendedCard();
    const reference = typeof b.reference === 'string' ? b.reference : '';
    if (
      [...this.intents.values()].some(
        (i) => i.reference === reference && i.account_id === b.account_id,
      )
    ) {
      return {
        status: 409,
        body: errorBody(
          'error_duplicate_resource',
          'A record with this reference already exists.',
        ),
      };
    }
    if (!this.accounts.accounts.get(String(b.account_id))) {
      return {
        status: 404,
        body: errorBody(
          'error_resource_not_found',
          "We couldn't find that account.",
        ),
      };
    }
    const i: StandinIntent = {
      id: id('PI'),
      currency: String(b.currency),
      amount: Number(b.amount),
      reference,
      description: typeof b.description === 'string' ? b.description : null,
      status: 'requires_action',
      entity_id: String(b.entity_id),
      account_id: String(b.account_id),
      created: Date.now(),
      intent_action: null,
    };
    this.intents.set(i.id, i);
    return {
      status: 201,
      body: envelope(i, 'Payment intent created successfully'),
    };
  }

  private confirm(req: StandinRequest): StandinAnswer {
    this.confirmBodies.push(req.body);
    const b = (req.body ?? {}) as Body;
    const i = this.intents.get(String(b.payment_intent_id));
    if (!i) return this.missing();
    if (i.status !== 'requires_action') {
      return {
        status: 409,
        body: errorBody(
          'error_acquiring_payment_already_processed',
          'Already processed.',
        ),
      };
    }
    if (this.suspended) return this.suspendedCard();
    if (this.refuseNaira && i.currency === 'NGN') {
      return {
        status: 400,
        body: errorBody(
          'error_acquiring_currency_not_supported',
          'The currency for this payment is currently not supported',
        ),
      };
    }
    const a = b.intent_action ?? {};
    const isCard = a.payment_type === 'card-acq';
    if (
      isCard &&
      (typeof a.payment_type_data?.data !== 'string' ||
        !a.payment_type_data.billing_address)
    ) {
      return {
        status: 400,
        body: errorBody(
          'error_validation_invalid_format',
          'Invalid card data.',
        ),
      };
    }
    if (isCard && this.cardMode === 'bad_card') {
      return {
        status: 400,
        body: errorBody(
          'error_acquiring_payment_method_invalid',
          'The card could not be read.',
        ),
      };
    }
    const mode: CardMode = isCard ? this.cardMode : 'threeds';
    const action = {
      id: id('IA'),
      currency: i.currency,
      amount: i.amount,
      applicable_fee: this.cardFee,
      charge_amount: i.amount,
      refunded_amount: 0,
      reference: i.reference,
      action: 'confirm',
      category: 'collections',
      payment_type: a.payment_type,
      payment_type_data: isCard
        ? {
            payment_country: 'NG',
            auth_model: '3ds_required',
            last_four_digits: '1111',
            ...(mode === 'frictionless'
              ? { card_brand: 'visa', card_type: 'debit' }
              : {}),
          }
        : { payment_country: 'NG' },
      status:
        mode === 'frictionless'
          ? 'completed'
          : mode === 'decline'
            ? 'failed'
            : 'pending_user_action',
      ...(mode === 'decline'
        ? { status_reason: 'Card declined by the issuer' }
        : {}),
      entity_id: i.entity_id,
      account_id: i.account_id,
      payment_intent_id: i.id,
      return_url: a.return_url,
      ...(mode === 'threeds'
        ? {
            requires_action: true,
            next_action: {
              type: 'redirect_to_url',
              url: `https://app.nuvion.test/sessions/${id('S').toLowerCase()}`,
            },
          }
        : {}),
      created: Date.now(),
    };
    i.intent_action = action;
    i.status =
      mode === 'frictionless'
        ? 'completed'
        : mode === 'decline'
          ? 'failed'
          : 'processing';
    return {
      status: 201,
      body: envelope(action, 'Payment intent action created successfully'),
    };
  }

  private createSession(req: StandinRequest): StandinAnswer {
    const b = (req.body ?? {}) as Body;
    if (this.suspended) {
      return {
        status: 403,
        body: errorBody(
          'error_auth_permission_denied',
          'Funding sessions are suspended for this account.',
        ),
      };
    }
    if (this.refuseNaira && b.currency === 'NGN') {
      return {
        status: 503,
        body: errorBody(
          'error_system_dependency_unavailable',
          'One of our partner services is temporarily unavailable. Please try again in a few minutes.',
        ),
      };
    }
    if (
      [...this.sessions.values()].some(
        (x) => x.unique_reference === b.unique_reference,
      )
    ) {
      return {
        status: 409,
        body: errorBody(
          'error_duplicate_resource',
          'A record with this unique_reference already exists.',
        ),
      };
    }
    const momo = b.funding_type === 'momo';
    const x: StandinSession = {
      id: id('FS'),
      status: 'awaiting_user',
      amount: Number(b.amount),
      currency: String(b.currency),
      account_id: String(b.account_id),
      unique_reference: String(b.unique_reference),
      funding_type: momo ? 'momo' : 'open-banking',
      entity_id: String(b.entity_id),
      narration: typeof b.narration === 'string' ? b.narration : null,
      ...(momo ? { meta: b.meta } : { redirect_url: b.redirect_url }),
      expires_at: momo ? null : Date.now() + 15 * 60_000,
      created: Date.now(),
    };
    if (!momo) x.checkout_url = `https://app.nuvion.test/checkout/${x.id}`;
    this.sessions.set(x.id, x);
    return {
      status: 201,
      body: envelope(
        {
          id: x.id,
          status: x.status,
          unique_reference: x.unique_reference,
          currency: x.currency,
          amount: x.amount,
          ...(momo
            ? { channel: (b.meta ?? {}).channel, msisdn: (b.meta ?? {}).msisdn }
            : { checkout_url: x.checkout_url }),
          expires_at: x.expires_at,
        },
        'Funding session created successfully',
      ),
    };
  }

  private sessionView(x: StandinSession): Record<string, unknown> {
    const rest: Record<string, unknown> = { ...x, updated: Date.now() };
    delete rest.entity_id;
    delete rest.funding_type;
    return rest;
  }
}
