import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NuvionSettings } from '../../src/nuvion/nuvion-config';
import { NUVION_API_VERSION } from '../../src/nuvion/nuvion-config';
import { NUVION_DOCUMENTED_ERRORS } from './nuvion-errors';

/**
 * A local HTTP stand-in for Nuvion (task NUV-01), for every NUV spec. The
 * Nuvion sandbox key does not work yet (401, SANDBOX-FINDINGS), and no spec
 * may reach a Nuvion host, so the client is tested here over a real socket:
 * headers, query strings, bodies, status codes, timeouts and lost answers as
 * `fetch` sees them.
 *
 * Its answers are Nuvion's own examples (the lead's scratchpad
 * `nuvion/docs/`): the envelope and cursor pages of `pagination.md`, the
 * bank list of `api-reference__bank-codes.md`, the account of
 * `api-reference__accounts.md`, the pending transfer of
 * `api-reference__transfers.md`, and the error objects of `errors.md`
 * (every documented type, at its documented status). Every answer carries an
 * `X-Request-ID`, as Nuvion's errors do.
 *
 * Switches, each for the next request only (or the next `n`):
 * - `failNext(type)`: that documented error;
 * - `rateLimitNext(retryAfter)`: 429 with Retry-After;
 * - `statusNext(status, body)`: any status and body (a gateway page, a 5xx);
 * - `slowNext(ms)`: answer after `ms` (past the client's timeout);
 * - `stallBodyNext(ms)`: headers now, the body after `ms`;
 * - `loseNext()`: close the socket without answering;
 * - `garbleNext()`: a 200 whose body is not JSON.
 * Routes a later NUV task needs are added with `on(...)`.
 */

export interface StandinRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface StandinAnswer {
  status: number;
  /** An object is sent as JSON; a string as it is. */
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Headers at once, then the body after this long. */
  bodyDelayMs?: number;
  hangUp?: boolean;
  contentType?: string | null;
}

type Handler = (req: StandinRequest) => StandinAnswer;

/** `{ status: "success", message, data }` (pagination.md, "Response envelope"). */
export function envelope(data: unknown, message = 'OK'): unknown {
  return { status: 'success', message, data };
}

/** Nuvion's error object (errors.md, "The error object"). */
export function errorBody(type: string, message = 'Something went wrong.') {
  return { status: 'error', message, type };
}

/** The status errors.md gives a documented type. */
export function documentedStatus(type: string): number {
  const hit = NUVION_DOCUMENTED_ERRORS.find(([t]) => t === type);
  if (!hit) throw new Error(`not a documented Nuvion error type: ${type}`);
  return hit[1];
}

/** The Nigerian bank list example (api-reference__bank-codes.md, "NG"). */
export const NG_BANK_CODES = [
  {
    bank_code: '120001',
    bank_name: '9 Payment Service Bank',
    swift_bic: 'IPSBNGLA',
  },
  { bank_code: '090270', bank_name: 'AB Microfinance Bank', swift_bic: null },
  {
    bank_code: '090260',
    bank_name: 'Above Only Microfinance Bank',
    swift_bic: null,
  },
];

/** One account as pagination.md's example lists it, with its own id. */
export function exampleAccount(id: string, n = 0) {
  return {
    entity_id: '01HXYZ2345ABCDEFGHJKMNPQRS',
    type: 'checking',
    currency: 'NGN',
    display_name: `Main NGN Account ${n}`,
    config: { is_overdraftable: false, overdraft_limit: 0 },
    nuvion_ban: `NVXYT${String(n).padStart(5, '0')}`,
    created: 1761820364358,
    updated: 1784718768076,
    balance: { current: 104727, available: 104727, overdraft_used: 0 },
    id,
    status: 'active',
  };
}

/** A ULID-shaped id for the n-th example row. */
export function exampleId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(26 - prefix.length, '0')}`.slice(0, 26);
}

export class NuvionStandin {
  readonly seen: StandinRequest[] = [];
  private routes: Array<{
    method: string;
    path: string | RegExp;
    handler: Handler;
  }> = [];
  private queued: Handler[] = [];
  private server: Server | null = null;
  private port = 0;
  /** Accounts the paged list serves (`GET /accounts`), for the cursor walk. */
  accounts = Array.from({ length: 7 }, (_, i) =>
    exampleAccount(exampleId('01HXYZACC', i + 1), i + 1),
  );

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Settings for a client pointed here (never Nuvion's hosts). */
  settings(over: Partial<NuvionSettings> = {}): NuvionSettings {
    return {
      baseUrl: this.baseUrl,
      environment: 'standin',
      apiVersion: NUVION_API_VERSION,
      operationalAccountId: '01HXYZOPERATIONAL000000001',
      readTimeoutMs: 1_500,
      moneyTimeoutMs: 1_500,
      checkTimeoutMs: 1_500,
      resendSafetyMs: 60_000,
      retryAfterSeconds: 30,
      ...over,
    };
  }

  /** Answer `method path` (exact, or a pattern). Later wins. */
  on(
    method: string,
    path: string | RegExp,
    answer: StandinAnswer | Handler,
  ): this {
    const handler = typeof answer === 'function' ? answer : () => answer;
    this.routes.unshift({ method, path, handler });
    return this;
  }

  /** The next request (whatever it is) gets this answer instead. */
  next(answer: StandinAnswer | Handler, times = 1): this {
    const handler = typeof answer === 'function' ? answer : () => answer;
    for (let i = 0; i < times; i += 1) this.queued.push(handler);
    return this;
  }

  failNext(type: string, message?: string): this {
    return this.next({
      status: documentedStatus(type),
      body: errorBody(type, message),
    });
  }

  rateLimitNext(retryAfterSeconds: number): this {
    return this.next({
      status: 429,
      body: errorBody(
        'error_auth_rate_limit_exceeded',
        'Too many requests; retry after the indicated delay.',
      ),
      headers: { 'Retry-After': String(retryAfterSeconds) },
    });
  }

  statusNext(
    status: number,
    body?: unknown,
    contentType?: string | null,
  ): this {
    return this.next({ status, body, contentType });
  }

  slowNext(ms: number): this {
    return this.next((req) => ({ ...this.route(req), delayMs: ms }));
  }

  stallBodyNext(ms: number): this {
    return this.next((req) => ({ ...this.route(req), bodyDelayMs: ms }));
  }

  loseNext(): this {
    return this.next({ status: 0, hangUp: true });
  }

  garbleNext(): this {
    return this.next({
      status: 200,
      body: '<html>gateway</html>',
      contentType: 'text/html',
    });
  }

  reset(): void {
    this.queued = [];
    this.seen.length = 0;
  }

  async start(): Promise<void> {
    this.defaults();
    this.server = createServer((req, res) => {
      void this.read(req).then((seen) => {
        this.seen.push(seen);
        const handler = this.queued.shift();
        const answer = handler ? handler(seen) : this.route(seen);
        const requestId =
          `01REQ${randomBytes(8).toString('hex').toUpperCase()}`.slice(0, 26);
        const send = () => {
          if (answer.hangUp) {
            req.socket.destroy();
            return;
          }
          const text =
            typeof answer.body === 'string'
              ? answer.body
              : answer.body === undefined
                ? ''
                : JSON.stringify(answer.body);
          const type =
            answer.contentType === undefined
              ? 'application/json'
              : answer.contentType;
          res.statusCode = answer.status;
          if (type !== null) res.setHeader('Content-Type', type);
          res.setHeader('X-Request-ID', requestId);
          for (const [k, v] of Object.entries(answer.headers ?? {}))
            res.setHeader(k, v);
          if (answer.bodyDelayMs) {
            res.flushHeaders();
            setTimeout(() => res.end(text), answer.bodyDelayMs).unref();
            return;
          }
          res.end(text);
        };
        if (answer.delayMs) setTimeout(send, answer.delayMs).unref();
        else send();
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async read(req: IncomingMessage): Promise<StandinRequest> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    const url = new URL(req.url ?? '/', 'http://standin');
    return {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body,
    };
  }

  private route(req: StandinRequest): StandinAnswer {
    const hit = this.routes.find(
      (r) =>
        r.method === req.method &&
        (typeof r.path === 'string'
          ? r.path === req.path
          : r.path.test(req.path)),
    );
    if (!hit) {
      return {
        status: 404,
        body: errorBody(
          'error_endpoint_not_found',
          'API endpoint does not exist',
        ),
      };
    }
    return hit.handler(req);
  }

  /** The docs' own examples. */
  private defaults(): void {
    this.on('GET', /^\/bank-codes\/[A-Z]{2}$/, (req) => ({
      status: 200,
      body: envelope(
        req.path.endsWith('/NG') ? NG_BANK_CODES : [],
        'Bank codes retrieved successfully',
      ),
    }));
    // A cursor list (pagination.md): `limit` rows a page, `cursor` = the
    // last id of the page before, `has_next` until the end.
    this.on('GET', '/accounts', (req) => {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));
      const start = req.query.cursor
        ? this.accounts.findIndex((a) => a.id === req.query.cursor) + 1
        : 0;
      const page = this.accounts.slice(start, start + limit);
      const hasNext = start + limit < this.accounts.length;
      return {
        status: 200,
        body: envelope(
          {
            data: page,
            meta: {
              pagination: {
                order: 'asc',
                has_next: hasNext,
                limit,
                has_previous: start > 0,
                next_cursor: hasNext ? page[page.length - 1].id : null,
                previous_cursor: start > 0 ? this.accounts[start - 1].id : null,
              },
              filters_applied: { entity_id: req.query.entity_id ?? null },
            },
          },
          'Accounts retrieved successfully',
        ),
      };
    });
    this.on('GET', /^\/accounts\/[A-Za-z0-9]+$/, (req) => {
      const id = req.path.split('/')[2];
      const account = this.accounts.find((a) => a.id === id);
      return account
        ? {
            status: 200,
            body: envelope(account, 'Account retrieved successfully'),
          }
        : {
            status: 404,
            body: errorBody(
              'error_resource_not_found',
              'Resource does not exist',
            ),
          };
    });
    // A transfer accepted for processing (api-reference__transfers.md).
    this.on('POST', '/transfers', (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        status: 201,
        body: envelope(
          {
            id: '01HXYZTRANSFER00000000001',
            amount: b.amount ?? 0,
            currency: b.currency ?? 'NGN',
            unique_reference: b.unique_reference ?? null,
            account_id: b.account_id ?? null,
            status: 'pending',
            status_reason: 'awaiting_processing',
            type: 'outflow',
            payment_type: b.payment_type ?? 'book-transfer',
            applicable_fee: 0,
          },
          'Transfer created successfully',
        ),
      };
    });
  }
}
