import { BadGatewayException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/**
 * How long one call to WAWU ID may take (task FIX-10). A call that has not
 * finished by then, headers AND body, is aborted and its socket freed, so a
 * stalled WAWU ID never holds a Hub request (or its connection) open.
 *
 * `read` is the batch identity lookup: it feeds lists and names, and a late
 * answer degrades to handles, so it is short. `write` is a call whose answer
 * the caller needs to tell the person whether it saved (a tick, a name, a
 * tier): longer, because an honest "did not save" is worse than a short wait.
 * Both can be overridden per deployment by `WAWU_ID_READ_TIMEOUT_MS` and
 * `WAWU_ID_WRITE_TIMEOUT_MS` (whole milliseconds; anything else is ignored).
 */
export const WAWU_ID_TIMEOUT_MS = {
  read: 3_000,
  write: 8_000,
} as const;

export type WawuIdCallKind = keyof typeof WAWU_ID_TIMEOUT_MS;

const CONFIG_KEY: Record<WawuIdCallKind, string> = {
  read: 'WAWU_ID_READ_TIMEOUT_MS',
  write: 'WAWU_ID_WRITE_TIMEOUT_MS',
};

/** The longest bound a deployment may set. */
const MAX_TIMEOUT_MS = 120_000;

/** The bound for one kind of call: the setting when it is whole and in range, else the default. */
export function wawuIdTimeoutMs(
  config: Pick<ConfigService, 'get'>,
  kind: WawuIdCallKind,
): number {
  const raw = config.get<string | number>(CONFIG_KEY[kind]);
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS
    ? n
    : WAWU_ID_TIMEOUT_MS[kind];
}

/**
 * WAWU ID did not answer inside its bound. A 502, which is what a write that
 * WAWU ID failed already answers (`BadGatewayException`), so every caller's
 * existing mapping holds; `call` and `boundMs` say which call and how long.
 * A read never throws it to a caller (a late lookup is an empty answer).
 */
export class WawuIdTimeoutException extends BadGatewayException {
  constructor(
    message: string,
    readonly call: string,
    readonly boundMs: number,
  ) {
    super(message);
  }
}

/**
 * One call's deadline, from the moment the request is sent until its body is
 * read or has failed. Built the way FIX-01 built Fintava's, for the same
 * reason: `AbortSignal.timeout(...)` is held by nothing once the headers are
 * in, so a collection can take its timer and a stalled body then waits for
 * undici's 300 s body timeout. A plain `setTimeout` holds this object (and
 * through it the controller and the body's reader) until `end()`; at the
 * deadline it aborts the controller, cancels the reader (which drops the
 * connection) and rejects a `fetch` still waiting for headers.
 */
export class WawuIdDeadline {
  readonly controller = new AbortController();
  readonly #timer: NodeJS.Timeout;
  #timedOut = false;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #onTimeout: ((reason: Error) => void) | null = null;

  constructor(
    readonly call: string,
    readonly boundMs: number,
    /** What the timeout says; callers pick words their screens already show. */
    readonly message: string,
  ) {
    this.#timer = setTimeout(() => this.#expire(), boundMs);
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  /** The exception a caller throws once `timedOut`. */
  timeout(): WawuIdTimeoutException {
    return new WawuIdTimeoutException(this.message, this.call, this.boundMs);
  }

  #expire(): void {
    this.#timedOut = true;
    const reason = new DOMException(
      'WAWU ID did not answer in time',
      'TimeoutError',
    );
    this.controller.abort(reason);
    this.#reader?.cancel(reason).catch(() => undefined);
    this.#onTimeout?.(reason);
  }

  /**
   * `fetch`'s answer, or a rejection at the deadline even if `fetch` never
   * settles. A response that arrives after the deadline has its body
   * cancelled, so its connection is not left open.
   */
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
          reject(
            e instanceof Error ? e : new Error('fetch failed', { cause: e }),
          );
        },
      );
    });
  }

  /** The body's reader, cancelled at the deadline. */
  watch(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.#reader = reader;
    if (this.#timedOut) reader.cancel().catch(() => undefined);
  }

  /** The call is over: the timer is cleared and nothing is held. */
  end(): void {
    clearTimeout(this.#timer);
    this.#reader = null;
    this.#onTimeout = null;
  }
}

/** What WAWU ID answered: the status and the body as text. */
export interface WawuIdAnswer {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * One request to WAWU ID, bounded by `deadline`. Throws the deadline's
 * `WawuIdTimeoutException` when the deadline passes before the answer is
 * whole (a body cut short is never taken for a whole one); any other failure
 * (the connection refused or reset) is thrown as `fetch` threw it.
 */
export async function wawuIdExchange(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  deadline: WawuIdDeadline,
): Promise<WawuIdAnswer> {
  let res: Response;
  try {
    res = await deadline.headers(
      fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: deadline.controller.signal,
        redirect: 'error',
      }),
    );
  } catch (e) {
    if (deadline.timedOut) throw deadline.timeout();
    throw e;
  }
  let text = '';
  try {
    if (res.body !== null) {
      const reader = res.body.getReader();
      deadline.watch(reader);
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
    }
  } catch (e) {
    if (deadline.timedOut) throw deadline.timeout();
    throw e;
  }
  // A cancelled reader ends with `done`: at the deadline that is a cut-short
  // body, not the end of one.
  if (deadline.timedOut) throw deadline.timeout();
  return { status: res.status, ok: res.ok, text };
}
