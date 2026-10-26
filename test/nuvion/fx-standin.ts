import {
  envelope,
  errorBody,
  type NuvionStandin,
  type StandinRequest,
} from './nuvion-standin';

/**
 * The foreign-currency side of Nuvion for WALLET-21's specs, stateful, in the
 * shapes Nuvion's DEV answered on 24 Oct 2026 (mobile `docs/nuvion/
 * DEV-RESULTS.md`, WALLET-21 rows): accounts per currency (`UST`, `USC`,
 * `RLD` for the coins), one set of account details per account (a second
 * chain is 409 `error_duplicate_resource`), quotes held about 179 seconds
 * (120 for a stablecoin pair) that carry no fee, book transfers with
 * `fx_quote_id`, stablecoin transfers that dev REFUSES with 400
 * `error_operation_invalid_for_state` (`refuseSends`), statements. Amounts
 * are the smallest unit; a stablecoin counts cents on dev.
 */

export const FX_ENTITY = '01FXENTITY000000000000001';
export const FX_NGN_ACCOUNT = '01FXNGNACCOUNT0000000001';
export const FX_NGN_BAN = '0011110001';

interface Acct {
  id: string;
  entity_id: string;
  type: string;
  currency: string;
  display_name: string;
  nuvion_ban: string;
  balance: { available: number; current: number; overdraft_used: number };
  deleted: number;
}

/** Rates in smallest units per smallest unit, from dev (NGN kobo to USD cents and so on). */
const RATES: Record<string, number> = {
  'NGN>USD': 0.000741,
  'NGN>UST': 0.00073,
  'NGN>USC': 0.00073,
  'NGN>RLD': 0.00073,
  'NGN>EUR': 0.000649,
  'NGN>GBP': 0.000544,
  'USD>NGN': 1315.440043,
  'USD>EUR': 0.871432,
};

export class FxStandin {
  readonly accounts = new Map<string, Acct>();
  readonly details = new Map<string, Record<string, unknown>>();
  readonly quotes = new Map<string, Record<string, unknown>>();
  readonly transfers: Array<Record<string, unknown>> = [];
  readonly counterparties: Array<Record<string, unknown>> = [];
  readonly paymentDetails: Array<Record<string, unknown>> = [];
  /** `active` (dev: GHS), `pending` (dev: USD, EUR, GBP at once) or `unavailable` (dev: CAD, AED, 503). */
  detailsMode: 'active' | 'pending' | 'unavailable' = 'active';
  /** Dev refuses a stablecoin send: 400 error_operation_invalid_for_state. */
  refuseSends = true;
  /** A transfer is answered `pending` instead of `successful`. */
  transferStatus: 'successful' | 'pending' = 'successful';
  private n = 0;

  constructor(
    private readonly s: NuvionStandin,
    readonly entityId = FX_ENTITY,
  ) {
    this.accounts.set(FX_NGN_ACCOUNT, {
      id: FX_NGN_ACCOUNT,
      entity_id: entityId,
      type: 'checking',
      currency: 'NGN',
      display_name: 'Naira',
      nuvion_ban: FX_NGN_BAN,
      balance: { available: 790_921, current: 790_921, overdraft_used: 0 },
      deleted: 0,
    });
  }

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}${String(this.n).padStart(26 - prefix.length, '0')}`;
  }

  install(): this {
    const s = this.s;
    s.on('POST', '/accounts', (req) => {
      const b = req.body as Record<string, string>;
      const id = this.id('01FXACC');
      const a: Acct = {
        id,
        entity_id: b.entity_id,
        type: b.type,
        currency: b.currency,
        display_name: b.display_name,
        nuvion_ban: `00${String(1_000_000 + this.n)}`,
        balance: { available: 0, current: 0, overdraft_used: 0 },
        deleted: 0,
      };
      this.accounts.set(id, a);
      return {
        status: 201,
        body: envelope({ account: a }, 'Account created successfully'),
      };
    });
    s.on('GET', /^\/accounts\/[^/]+$/, (req) => {
      const a = this.accounts.get(req.path.split('/')[2]);
      return a
        ? {
            status: 200,
            body: envelope({ account: a }, 'Account retrieved successfully'),
          }
        : {
            status: 404,
            body: errorBody('error_resource_not_found', 'not found'),
          };
    });
    s.on('POST', '/account-details', (req) => {
      const b = req.body as Record<string, string>;
      if (this.detailsMode === 'unavailable') {
        return {
          status: 503,
          body: errorBody(
            'error_system_dependency_unavailable',
            'One of our partner services is temporarily unavailable.',
          ),
        };
      }
      if (this.details.has(b.account_id)) {
        return {
          status: 409,
          body: errorBody(
            'error_duplicate_resource',
            'A record with this account detail already exists.',
          ),
        };
      }
      const a = this.accounts.get(b.account_id)!;
      const stable = ['UST', 'USC', 'RLD'].includes(a.currency);
      const d: Record<string, unknown> = {
        id: this.id('01FXDET'),
        entity_id: a.entity_id,
        account_id: a.id,
        status: this.detailsMode,
        asset_type: stable ? 'stablecoin' : 'fiat',
        currency: a.currency,
        beneficiary_name: 'Ngozi Eze',
        deleted: 0,
        ...(stable
          ? {
              chain: b.chain,
              account_number: `0x${'ab'.repeat(20)}`,
              issuer: {
                code: `${b.chain.toUpperCase()}_MAINNET`,
                name: `${b.chain.toUpperCase()}_MAINNET`,
              },
            }
          : a.currency === 'USD'
            ? {
                account_number: '9637380001',
                routing_number: '101019644',
                issuer: {
                  name: 'Bank of Nowhere',
                  code: '101019644',
                  scheme: 'routing_number',
                  meta: {
                    bank_address: '1 Example Street',
                    routing_number: '101019644',
                    swift_code: 'NOWHUS33',
                  },
                },
              }
            : {
                account_number: '7003000100286',
                issuer: { name: 'Global Remit', code: 'NUV', meta: {} },
              }),
      };
      this.details.set(a.id, d);
      return {
        status: 201,
        body: envelope(
          {
            account_details:
              this.detailsMode === 'pending'
                ? { ...d, account_number: undefined }
                : d,
          },
          'Account detail created successfully',
        ),
      };
    });
    s.on('GET', '/account-details', (req) => {
      const d = this.details.get(req.query.account_id);
      return { status: 200, body: envelope(page(d ? [d] : [])) };
    });
    s.on('POST', '/fx-quotes', (req) => {
      const b = req.body as {
        from_currency: string;
        to_currency: string;
        amount_from?: number;
        amount_to?: number;
        account_id?: string;
        entity_id?: string;
      };
      // Dev (26 Oct 2026, PAY-FX): WAWU's operational account is the
      // authenticating entity's own, so a quote from it names no entity_id.
      const source = b.account_id ? this.accounts.get(b.account_id) : undefined;
      if (!b.entity_id && source?.type !== 'operational')
        return {
          status: 404,
          body: errorBody('error_resource_not_found', 'account not found'),
        };
      const key = `${b.from_currency}>${b.to_currency}`;
      const rate = RATES[key] ?? 1;
      const from = b.amount_from ?? Math.round((b.amount_to ?? 0) / rate);
      const to = b.amount_to ?? Math.round(from * rate);
      const stable =
        ['UST', 'USC', 'RLD'].includes(b.from_currency) &&
        ['UST', 'USC', 'RLD'].includes(b.to_currency);
      const secs = stable ? 120 : 179;
      const id = this.id('01FXQ');
      const now = Date.now();
      const q = {
        id,
        from: b.from_currency,
        to: b.to_currency,
        amount_from: from,
        amount_to: to,
        rate,
        quote: {
          status: 'active',
          expires_at: now + secs * 1000,
          valid_for: secs - 1,
          used_at: null,
          used_in_payment_id: null,
        },
        created: now,
        updated: now,
      };
      this.quotes.set(id, q);
      return {
        status: 201,
        body: envelope(q, 'FX quote created successfully'),
      };
    });
    s.on('POST', '/transfers', (req) => this.transfer(req));
    s.on('GET', /^\/transfers\/[^/]+$/, (req) => {
      const t = this.transfers.find((x) => x.id === req.path.split('/')[2]);
      return t
        ? { status: 200, body: envelope(t, 'Transfer retrieved successfully') }
        : {
            status: 404,
            body: errorBody('error_resource_not_found', 'not found'),
          };
    });
    s.on('GET', '/transfers', (req) => ({
      status: 200,
      body: envelope(
        page(
          this.transfers.filter(
            (t) =>
              !req.query.account_id || t.account_id === req.query.account_id,
          ),
        ),
      ),
    }));
    s.on('GET', /^\/entities\/[^/]+$/, () => ({
      status: 200,
      body: envelope({
        person: { email: 'ngozi@example.test' },
        address: {
          line_1: '12 Awolowo Road',
          city: 'Lagos',
          state: 'Lagos',
          postal_code: '101233',
          country_code: 'NG',
        },
      }),
    }));
    s.on('GET', '/counterparties', () => ({
      status: 200,
      body: envelope(page(this.counterparties)),
    }));
    s.on('POST', '/counterparties', (req) => {
      const b = req.body as {
        meta?: Record<string, string>;
        entity_id: string;
      };
      const c = {
        id: this.id('01FXCP'),
        entity_id: b.entity_id,
        status: 'active',
        meta: b.meta ?? {},
        deleted: 0,
      };
      this.counterparties.push(c);
      return {
        status: 201,
        body: envelope(c, 'Counterparty created successfully'),
      };
    });
    s.on('GET', /^\/counterparties\/[^/]+\/payment-details$/, (req) => ({
      status: 200,
      body: envelope(
        page(
          this.paymentDetails.filter(
            (p) => p.counterparty_id === req.path.split('/')[2],
          ),
        ),
      ),
    }));
    s.on('POST', '/payment-details', (req) => {
      const b = req.body as Record<string, string>;
      if (
        ![
          'ETH_MAINNET',
          'BASE_MAINNET',
          'MATIC_MAINNET',
          'SOLANA_MAINNET',
        ].includes(b.blockchain_network)
      ) {
        return {
          status: 422,
          body: errorBody(
            'error_validation_error',
            'blockchain_network is not supported',
          ),
        };
      }
      const p = { id: this.id('01FXPD'), ...b };
      this.paymentDetails.push(p);
      return {
        status: 201,
        body: envelope(p, 'Payment detail created successfully'),
      };
    });
    s.on('GET', /^\/accounts\/[^/]+\/statements$/, (req) => {
      const id = req.path.split('/')[2];
      const lines = this.transfers
        .filter((t) => t.account_id === id)
        .map((t) => ({
          transaction_id: t.id,
          date: new Date().toISOString(),
          type: 'debit',
          description: t.narration,
          counterparty: { name: 'Outside', account_number: null },
          amount: t.amount,
          fee: t.applicable_fee,
          net_amount: t.amount,
          running_balance: this.accounts.get(id)?.balance.available ?? 0,
          reference: t.unique_reference,
          status: 'completed',
          currency: this.accounts.get(id)?.currency,
        }));
      return {
        status: 200,
        body: envelope({
          account_id: id,
          transactions: lines,
          pagination: {
            order: 'asc',
            has_next: false,
            limit: 100,
            has_previous: false,
            next_cursor: null,
            previous_cursor: null,
          },
        }),
      };
    });
    return this;
  }

  private transfer(req: StandinRequest) {
    const b = req.body as Record<string, string | number | undefined>;
    const from = this.accounts.get(String(b.account_id));
    if (!from)
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'account not found'),
      };
    const dup = this.transfers.find(
      (t) => t.unique_reference === b.unique_reference,
    );
    if (dup)
      return {
        status: 409,
        body: errorBody(
          'error_duplicate_resource',
          'A transfer with this reference already exists.',
        ),
      };
    if (b.payment_type === 'stablecoin-transfer' && this.refuseSends) {
      return {
        status: 400,
        body: errorBody(
          'error_operation_invalid_for_state',
          "You can't perform this action right now due to the current status. Please try again later or contact support.",
        ),
      };
    }
    const amount = Number(b.amount);
    if (from.balance.available < amount) {
      return {
        status: 400,
        body: errorBody(
          'error_transfer_insufficient_funds',
          `You don't have enough funds for this transfer. Your available balance is ${from.balance.available / 100} ${from.currency}.`,
        ),
      };
    }
    if (b.payment_type === 'book-transfer') {
      // Dev (24 Oct, the verifier's H1): a transfer to the sender's own
      // account is refused 400 and leaves a `failed` record under the
      // reference, which a repeat of the reference then finds (409).
      const target = [...this.accounts.values()].find(
        (a) => a.nuvion_ban === b.nuvion_ban,
      );
      if (target && target.id === from.id) {
        this.transfers.push({
          id: this.id('01FXTR'),
          amount,
          currency: b.currency,
          unique_reference: b.unique_reference,
          account_id: from.id,
          entity_id: from.entity_id,
          status: 'failed',
          status_reason: 'cannot_transfer_to_same_account',
          narration: b.narration,
          type: 'outflow',
          payment_type: b.payment_type,
          applicable_fee: 0,
          meta: {},
          created: Date.now(),
          updated: Date.now(),
        });
        return {
          status: 400,
          body: errorBody(
            'error_validation_error',
            'cannot_transfer_to_same_account',
          ),
        };
      }
      if (b.fx_quote_id) {
        const q = this.quotes.get(String(b.fx_quote_id));
        if (!q || (q.quote as { status: string }).status !== 'active') {
          return {
            status: 400,
            body: errorBody(
              'error_fx_quote_expired',
              'The quote is no longer valid.',
            ),
          };
        }
        if (b.currency !== q.from)
          return {
            status: 422,
            body: errorBody(
              'error_fx_quote_currency_mismatch',
              'currency must be the quote source',
            ),
          };
        (q.quote as { status: string }).status = 'used';
        const to = [...this.accounts.values()].find(
          (a) => a.nuvion_ban === b.nuvion_ban,
        );
        if (!to)
          return {
            status: 404,
            body: errorBody(
              'error_resource_not_found',
              'no account for that nuvion_ban',
            ),
          };
        from.balance.available -= amount;
        from.balance.current -= amount;
        to.balance.available += Number(q.amount_to);
        to.balance.current += Number(q.amount_to);
      } else {
        const to = [...this.accounts.values()].find(
          (a) => a.nuvion_ban === b.nuvion_ban,
        );
        from.balance.available -= amount;
        from.balance.current -= amount;
        if (to) {
          to.balance.available += amount;
          to.balance.current += amount;
        }
      }
    } else {
      from.balance.available -= amount;
      from.balance.current -= amount;
    }
    const t = {
      id: this.id('01FXTR'),
      amount,
      currency: b.currency,
      unique_reference: b.unique_reference,
      counterparty_id: from.id,
      account_id: from.id,
      entity_id: from.entity_id,
      status: this.transferStatus,
      status_reason:
        this.transferStatus === 'successful'
          ? 'processing_complete'
          : 'awaiting_processing',
      narration: b.narration,
      type: 'outflow',
      payment_type: b.payment_type,
      applicable_fee: 0,
      meta: b.fx_quote_id ? { fx_quote_id: b.fx_quote_id } : {},
      created: Date.now(),
      updated: Date.now(),
    };
    this.transfers.push(t);
    return { status: 201, body: envelope(t, 'Transfer created successfully') };
  }

  /** Puts spendable money on an account (what the swap tests start from). */
  fund(accountId: string, amount: number): void {
    const a = this.accounts.get(accountId)!;
    a.balance.available += amount;
    a.balance.current += amount;
  }

  /** An account of another holder (WAWU's collector) that a book transfer can name by its nuvion_ban. */
  addCollector(ban: string, currency: string): Acct {
    const id = this.id('01FXCOL');
    const a: Acct = {
      id,
      entity_id: '01FXWAWUENTITY00000000001',
      type: 'operational',
      currency,
      display_name: 'WAWU collector',
      nuvion_ban: ban,
      balance: { available: 0, current: 0, overdraft_used: 0 },
      deleted: 0,
    };
    this.accounts.set(id, a);
    return a;
  }

  /** WAWU's own operational naira account, under the id the adapter is configured with (PAY-FX). */
  addOperational(id: string, ban: string, kobo: number): Acct {
    const a: Acct = {
      id,
      entity_id: '01FXWAWUENTITY00000000001',
      type: 'operational',
      currency: 'NGN',
      display_name: 'WAWU operational',
      nuvion_ban: ban,
      balance: { available: kobo, current: kobo, overdraft_used: 0 },
      deleted: 0,
    };
    this.accounts.set(id, a);
    return a;
  }

  balanceOf(accountId: string): number {
    return this.accounts.get(accountId)!.balance.available;
  }

  /** The foreign account of a currency, as Nuvion holds it. */
  byCurrency(currency: string): Acct | undefined {
    return [...this.accounts.values()].find((a) => a.currency === currency);
  }
}

function page(rows: unknown[]) {
  return {
    data: rows,
    meta: {
      pagination: {
        order: 'asc',
        has_next: false,
        limit: 100,
        has_previous: false,
        next_cursor: null,
        previous_cursor: null,
      },
    },
  };
}
