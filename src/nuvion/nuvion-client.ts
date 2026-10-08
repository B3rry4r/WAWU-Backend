import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { type NuvionSettings } from './nuvion-config';
import {
  classifyNuvionFailure,
  maskNuvionText,
  type NuvionCallKind,
  NuvionError,
  nuvionLimitError,
} from './nuvion-error';
import type {
  NuvionAnswer,
  NuvionListPage,
  NuvionListQuery,
  NuvionPagination,
} from './nuvion.interface';
import type {
  WalletProviderError,
  WalletProviderErrorKind,
} from '../wallet-provider/wallet-provider-error';

/** Percent-decoding rounds a path segment is read through before refusal. */
const MAX_DECODE_DEPTH = 4;

/**
 * True when one path segment is, or decodes to at any depth, `.` or `..`
 * or a slash: `..`, `%2e%2e`, `%2E%2e`, `.%2e`, `%252e%252e`, `%2f`. The
 * URL parser reads `%2e%2e` as `..` and climbs out of the path the area
 * built (verifier finding 8, lead ruling 7). A segment that does not
 * decode, or still decodes after MAX_DECODE_DEPTH rounds, is refused too.
 */
export function unsafeSegment(segment: string): boolean {
  let text = segment;
  for (let depth = 0; depth <= MAX_DECODE_DEPTH; depth += 1) {
    if (
      text === '.' ||
      text === '..' ||
      text.includes('/') ||
      text.includes('\\')
    ) {
      return true;
    }
    if (!text.includes('%')) return false;
    let next: string;
    try {
      next = decodeURIComponent(text);
    } catch {
      return true;
    }
    if (next === text) return false;
    text = next;
  }
  return true;
}

/** One call, named for logs and errors. Never a URL: a query can hold an id. */
export interface NuvionOp {
  name: string;
  call: NuvionCallKind;
}

/** The largest answer read by default; past it the call fails, nothing buffered. */
const DEFAULT_MAX_ANSWER_BYTES = 5 * 1024 * 1024;
/** Pages a `listAll` reads before it stops and says the list is incomplete. */
const DEFAULT_MAX_PAGES = 50;
/** A request id we repeat in an error or a log: Nuvion's are ULIDs. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * One exchange's deadline, the headers AND the body, from the moment the
 * request is sent until the body is read or the read failed. A plain timer
 * holds the controller and the body's reader, and at the deadline cancels
 * both and rejects a `fetch` still waiting for headers (the same reasons as
 * the Fintava client's, FIX-01: a stalled body is never held open).
 */
class NuvionDeadline {
  readonly controller = new AbortController();
  #timedOut = false;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #onTimeout: ((reason: Error) => void) | null = null;
  readonly #timer: NodeJS.Timeout;

  constructor(ms: number) {
    this.#timer = setTimeout(() => this.#expire(), ms);
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  #expire(): void {
    this.#timedOut = true;
    const reason = new DOMException(
      'Nuvion did not answer in time',
      'TimeoutError',
    );
    this.controller.abort(reason);
    this.#reader?.cancel(reason).catch(() => undefined);
    this.#onTimeout?.(reason);
  }

  headers(answer: Promise<Response>): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      this.#onTimeout = reject;
      answer.then(
        (res) => {
          this.#onTimeout = null;
          if (this.#timedOut) {
            res.body?.cancel().catch(() => undefined);
            return;
          }
          resolve(res);
        },
        (e: unknown) => {
          this.#onTimeout = null;
          reject(e instanceof Error ? e : new Error('fetch failed'));
        },
      );
    });
  }

  watch(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.#reader = reader;
    if (this.#timedOut) reader.cancel().catch(() => undefined);
  }

  stop(): void {
    this.controller.abort();
  }

  end(): void {
    clearTimeout(this.#timer);
    this.#reader = null;
    this.#onTimeout = null;
  }
}

type BodyRead =
  { kind: 'text'; text: string } | { kind: 'over' } | { kind: 'failed' };

async function readBody(
  res: Response,
  cap: number,
  deadline: NuvionDeadline,
): Promise<BodyRead> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    if (Number(declared.trim()) > cap) {
      deadline.stop();
      res.body?.cancel().catch(() => undefined);
      return { kind: 'over' };
    }
  }
  if (res.body === null) return { kind: 'text', text: '' };
  const reader = res.body.getReader();
  deadline.watch(reader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        deadline.stop();
        reader.cancel().catch(() => undefined);
        return { kind: 'over' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'failed' };
  }
  if (deadline.timedOut) return { kind: 'failed' };
  return {
    kind: 'text',
    text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `data.meta.pagination`, read field by field; null when it is not one. */
function readPagination(meta: unknown): NuvionPagination | null {
  if (!isRecord(meta) || !isRecord(meta.pagination)) return null;
  const p = meta.pagination;
  if (typeof p.has_next !== 'boolean') return null;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    order: p.order === 'asc' || p.order === 'desc' ? p.order : null,
    hasNext: p.has_next,
    hasPrevious: p.has_previous === true,
    limit: typeof p.limit === 'number' ? p.limit : null,
    nextCursor: text(p.next_cursor),
    previousCursor: text(p.previous_cursor),
  };
}

/**
 * The one place this backend talks to Nuvion (task NUV-01). Every area of
 * the Nuvion adapter (src/nuvion/areas/) calls through it.
 *
 * What it keeps, each from Nuvion's docs (the lead's scratchpad
 * `nuvion/docs/`):
 * - `Authorization: Bearer <key>`, `Content-Type: application/json` and the
 *   pinned `X-API-Version` on every request (authentication.md,
 *   versioning.md). The key goes only to the configured Nuvion host, never
 *   follows a redirect, and is never in an error, a log or `inspect(client)`.
 * - The `{ status, message, data }` envelope (pagination.md): a 2xx without
 *   it is not proof of anything (`bad_response` on a read, `not_confirmed`
 *   on a write).
 * - Cursor paging on `limit` and `cursor`, followed by `has_next` and
 *   `next_cursor` until `has_next` is false (pagination.md: "Always check
 *   has_next").
 * - Every failure is a `NuvionError` (a `WalletProviderError`) of one kind,
 *   with Nuvion's `X-Request-ID` kept (errors.md), its `type`, and its texts
 *   masked. A write whose answer was lost (a timeout, no connection, a 5xx)
 *   is `outcome_unknown`: it is reconciled, never sent again blindly.
 * - 429 is `rate_limited`, with Nuvion's Retry-After when it sends one.
 * Logs name the operation, the HTTP status, the kind, the request id and our
 * reference; never a URL, a body or a header.
 */
export class NuvionClient {
  private readonly logger = new Logger(NuvionClient.name);
  readonly #apiKey: string;

  constructor(
    readonly settings: NuvionSettings,
    apiKey: string,
  ) {
    this.#apiKey = apiKey.trim();
  }

  get environment(): NuvionSettings['environment'] {
    return this.settings.environment;
  }

  /** What `console.log(client)` or a logged object shows: no key. */
  [inspect.custom](): string {
    return `NuvionClient { environment: '${this.settings.environment}' }`;
  }

  toJSON(): { environment: NuvionSettings['environment'] } {
    return { environment: this.settings.environment };
  }

  // -------------------------------------------------------------------------
  // The calls the areas use
  // -------------------------------------------------------------------------

  /** A GET, answered with the envelope's `data`. */
  get<T = unknown>(
    op: NuvionOp,
    path: string,
    query?: NuvionListQuery,
  ): Promise<NuvionAnswer<T>> {
    return this.request<T>(op, 'GET', path, { query });
  }

  /** A POST. `reference` is ours (a transfer's `unique_reference`), for logs and errors. */
  post<T = unknown>(
    op: NuvionOp,
    path: string,
    body: unknown,
    opts: { reference?: string; maxAnswerBytes?: number } = {},
  ): Promise<NuvionAnswer<T>> {
    return this.request<T>(op, 'POST', path, { body, ...opts });
  }

  patch<T = unknown>(
    op: NuvionOp,
    path: string,
    body: unknown,
  ): Promise<NuvionAnswer<T>> {
    return this.request<T>(op, 'PATCH', path, { body });
  }

  /** One page of a list: `data.data` and `data.meta.pagination`. */
  async listPage<T = unknown>(
    op: NuvionOp,
    path: string,
    query: NuvionListQuery = {},
  ): Promise<NuvionListPage<T> & { requestId: string | null }> {
    if (
      query.limit !== undefined &&
      (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    ) {
      throw new RangeError('limit is 1 to 100');
    }
    const answer = await this.get<unknown>(op, path, query);
    const data = answer.data;
    const pagination = isRecord(data) ? readPagination(data.meta) : null;
    if (!isRecord(data) || !Array.isArray(data.data) || !pagination) {
      throw this.fail(op, {
        kind: 'bad_response',
        status: answer.httpStatus,
        messages: ['the answer is not a list page'],
        requestId: answer.requestId,
      });
    }
    return {
      items: data.data as T[],
      pagination,
      requestId: answer.requestId,
    };
  }

  /**
   * Every page of a list, following `next_cursor` while `has_next` is true.
   * Stops after `maxPages` and says so (`complete: false`), so a caller
   * never takes a cut-off list for a whole one. A page that says more
   * follows but gives no cursor, or gives the one just used, is not
   * readable (`bad_response`): following it could loop or skip rows.
   */
  async listAll<T = unknown>(
    op: NuvionOp,
    path: string,
    query: NuvionListQuery = {},
    opts: { maxPages?: number } = {},
  ): Promise<{ items: T[]; complete: boolean; pages: number }> {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = query.cursor;
    for (let pages = 1; ; pages += 1) {
      const page = await this.listPage<T>(op, path, { ...query, cursor });
      items.push(...page.items);
      if (!page.pagination.hasNext) return { items, complete: true, pages };
      const next = page.pagination.nextCursor;
      if (next === null || next === cursor || seen.has(next)) {
        throw this.fail(op, {
          kind: 'bad_response',
          messages: ['a page says more follow but gives no new cursor'],
          requestId: page.requestId,
        });
      }
      if (pages >= maxPages) return { items, complete: false, pages };
      seen.add(next);
      cursor = next;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private timeoutFor(call: NuvionCallKind): number {
    if (call === 'write') return this.settings.moneyTimeoutMs;
    if (call === 'check') return this.settings.checkTimeoutMs;
    return this.settings.readTimeoutMs;
  }

  private fail(
    op: NuvionOp,
    args: {
      kind: WalletProviderErrorKind;
      status?: number | null;
      messages?: string[];
      reference?: string | null;
      requestId?: string | null;
      nuvionType?: string | null;
      recordMayExist?: boolean;
      retryAfterSeconds?: number;
    },
  ): WalletProviderError {
    const messages = (args.messages ?? []).map((m) =>
      maskNuvionText(m, [this.#apiKey]),
    );
    // Nuvion's limit refusals below 500 have one mapping point (G-411).
    const error =
      nuvionLimitError(args.nuvionType ?? null, {
        operation: op.name,
        httpStatus: args.status ?? null,
        messages,
        reference: args.reference ?? null,
        requestId: args.requestId ?? null,
      }) ??
      new NuvionError({
        kind: args.kind,
        operation: op.name,
        httpStatus: args.status ?? null,
        messages,
        reference: args.reference ?? null,
        requestId: args.requestId ?? null,
        nuvionType: args.nuvionType ?? null,
        recordMayExist: args.recordMayExist,
        retryAfterSeconds:
          args.retryAfterSeconds ?? this.settings.retryAfterSeconds,
      });
    this.logger.warn(
      `${op.name}: ${error.kind}` +
        (error.httpStatus === null ? '' : ` HTTP ${error.httpStatus}`) +
        (args.nuvionType ? ` ${args.nuvionType}` : '') +
        (args.requestId ? ` request ${args.requestId}` : '') +
        (error.reference ? ` ref ${error.reference}` : '') +
        (messages.length ? ` "${messages.join('; ')}"` : ''),
    );
    return error;
  }

  private url(path: string, query?: NuvionListQuery): URL {
    // Paths are ours, built by the areas: one leading slash, no traversal
    // (plain or percent-encoded, at any depth), no query or fragment of
    // their own. Anything else is a bug here.
    if (
      !/^\/[A-Za-z0-9._~%/-]*$/.test(path) ||
      path.includes('//') ||
      path.split('/').some(unsafeSegment)
    ) {
      throw new RangeError('A Nuvion path must be a plain absolute path.');
    }
    const url = new URL(`${this.settings.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async request<T>(
    op: NuvionOp,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: {
      query?: NuvionListQuery;
      body?: unknown;
      reference?: string;
      maxAnswerBytes?: number;
    },
  ): Promise<NuvionAnswer<T>> {
    if (this.#apiKey === '') throw this.fail(op, { kind: 'not_configured' });
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Version': this.settings.apiVersion,
    };
    const cap = opts.maxAnswerBytes ?? DEFAULT_MAX_ANSWER_BYTES;
    const started = Date.now();
    const deadline = new NuvionDeadline(this.timeoutFor(op.call));
    // No answer, or one cut short, is not evidence about the money.
    const lost = (why: string) =>
      this.fail(op, {
        kind: op.call === 'write' ? 'outcome_unknown' : 'unavailable',
        messages: [why],
        reference: opts.reference,
      });
    let res: Response;
    let read: BodyRead;
    try {
      try {
        res = await deadline.headers(
          fetch(url, {
            method,
            headers,
            body:
              opts.body === undefined ? undefined : JSON.stringify(opts.body),
            signal: deadline.controller.signal,
            redirect: 'error',
          }),
        );
      } catch {
        throw lost(deadline.timedOut ? 'timed out' : 'no connection');
      }
      read = await readBody(res, cap, deadline);
    } finally {
      deadline.end();
    }

    const rawId = res.headers.get('x-request-id')?.trim() ?? '';
    const requestId = REQUEST_ID.test(rawId) ? rawId : null;
    if (read.kind === 'over') {
      throw this.fail(op, {
        kind: op.call === 'write' ? 'not_confirmed' : 'bad_response',
        status: res.status,
        messages: [`the answer is over ${cap} bytes`],
        reference: opts.reference,
        requestId,
      });
    }
    if (read.kind === 'failed' && deadline.timedOut) throw lost('timed out');
    const text = read.kind === 'text' ? read.text : '';
    let body: unknown = null;
    let parsed = true;
    try {
      body = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = false;
    }
    const ms = Date.now() - started;

    if (res.status >= 200 && res.status < 300) {
      // The envelope is the proof: `status: "success"` and a `data` field.
      if (
        !parsed ||
        !isRecord(body) ||
        body.status !== 'success' ||
        !('data' in body)
      ) {
        throw this.fail(op, {
          kind: op.call === 'write' ? 'not_confirmed' : 'bad_response',
          status: res.status,
          messages: ['the answer is not a Nuvion success envelope'],
          reference: opts.reference,
          requestId,
        });
      }
      const line =
        `${op.name}: HTTP ${res.status} in ${ms} ms` +
        (requestId ? ` request ${requestId}` : '') +
        (opts.reference ? ` ref ${opts.reference}` : '');
      if (op.call === 'read') this.logger.debug(line);
      else this.logger.log(line);
      return {
        httpStatus: res.status,
        data: body.data as T,
        message: typeof body.message === 'string' ? body.message : null,
        requestId,
      };
    }

    const { kind, type, messages, recordMayExist } = classifyNuvionFailure({
      httpStatus: res.status,
      body: parsed ? body : null,
      call: op.call,
      secrets: [this.#apiKey],
    });
    let retryAfterSeconds: number | undefined;
    if (kind === 'rate_limited') {
      const raw = res.headers.get('retry-after')?.trim() ?? '';
      const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= 3600) retryAfterSeconds = n;
    }
    throw this.fail(op, {
      kind,
      status: res.status,
      messages,
      reference: opts.reference,
      requestId,
      nuvionType: type,
      recordMayExist,
      retryAfterSeconds,
    });
  }
}
