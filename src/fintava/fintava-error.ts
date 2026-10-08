import type { HttpException } from '@nestjs/common';
import { walletProviderErrorToHttp } from '../wallet-provider/wallet-provider-error';
import { FINTAVA_DEFAULTS } from './fintava-config';

/**
 * What kind of call failed. It decides what a 5xx or a timeout means:
 * - `read`: nothing changed at Fintava; try again.
 * - `write`: money may have moved or something changed (a send, a bill,
 *   a freeze, opening an account); the outcome is unknown until a lookup
 *   settles it.
 * - `check`: a BVN, selfie or phone check; a refusal is about the person.
 */
export type FintavaCallKind = 'read' | 'write' | 'check';

/**
 * Every way a Fintava call can fail, read from the HTTP status AND the
 * message (mobile repo `docs/fintava/naira-api.md`, "Errors"; the codes alone
 * mislead: a wrong key is 400 or 404, a NIN refusal is 403, an unknown
 * transaction id is 200).
 */
export const FINTAVA_ERROR_KINDS = [
  /** No key in config: nothing was sent. */
  'not_configured',
  /** The key is missing or wrong (401, or 400/404 "Invalid API key"). */
  'auth',
  /** 403 "Merchant is not active". */
  'merchant_inactive',
  /** Fintava's validation refused our request body (the nested shape). */
  'validation',
  'insufficient_funds',
  /** "Kindly confirm both customer accounts are active": a frozen sender or receiver. */
  'wallet_inactive',
  /**
   * Our `CustomerReference` was used before: Fintava already has a send
   * under it, so money may have moved. An unknown outcome like
   * `outcome_unknown` (`recordMayExist` is true): reconcile, never refund
   * or charge again on it.
   */
  'duplicate_reference',
  'not_found',
  /** "Airtime amount is less than 100". */
  'below_minimum',
  /** A BVN, selfie or phone check said no, or a NIN is blacklisted. */
  'identity_refused',
  /** "Unable to find customers": every payout in the sandbox (question 17). */
  'payouts_blocked',
  /** A 2xx on a write without the expected data in it: not proof either way. */
  'not_confirmed',
  /** Any other refusal. */
  'refused',
  'rate_limited',
  /** A read timed out, could not connect, or got a 5xx: safe to try again. */
  'unavailable',
  /** A write timed out, could not connect, or got a 5xx: reconcile first. */
  'outcome_unknown',
  /** A 2xx we could not read on a read call. */
  'bad_response',
] as const;
export type FintavaErrorKind = (typeof FINTAVA_ERROR_KINDS)[number];

/**
 * The kinds after which a write may have happened: the caller treats each
 * as "pending, reconcile", never as a failure to refund or retry blindly.
 */
export const FINTAVA_UNKNOWN_OUTCOMES: readonly FintavaErrorKind[] = [
  'outcome_unknown',
  'not_confirmed',
  'duplicate_reference',
];

/**
 * A failed Fintava call. It carries no request or response body and no
 * header: `messages` are Fintava's texts with digits and emails masked, so
 * the error can be logged as it is. Its `message` names the operation, never
 * the URL (a query can carry a BVN or a phone).
 */
export class FintavaError extends Error {
  readonly kind: FintavaErrorKind;
  readonly operation: string;
  /** HTTP status, or null when no answer came back. */
  readonly httpStatus: number | null;
  readonly messages: string[];
  /** Our `CustomerReference`, on a send that carried one. */
  readonly reference: string | null;
  /**
   * True when money may have moved or a record may exist although the call
   * failed: an unknown outcome, a 2xx without a transaction, a repeated
   * reference (the earlier send exists), or any refusal of a bank send (a
   * refused bank send can still write a PENDING record and use its
   * reference up, `sandbox/14-`). A caller never refunds or charges again
   * while this is true; it reconciles.
   */
  readonly recordMayExist: boolean;

  constructor(args: {
    kind: FintavaErrorKind;
    operation: string;
    httpStatus?: number | null;
    messages?: string[];
    reference?: string | null;
    recordMayExist?: boolean;
  }) {
    const status = args.httpStatus ?? null;
    super(
      `Fintava ${args.operation} failed: ${args.kind}` +
        (status === null ? '' : ` (HTTP ${status})`),
    );
    this.name = 'FintavaError';
    this.kind = args.kind;
    this.operation = args.operation;
    this.httpStatus = status;
    this.messages = args.messages ?? [];
    this.reference = args.reference ?? null;
    this.recordMayExist =
      args.recordMayExist ?? FINTAVA_UNKNOWN_OUTCOMES.includes(args.kind);
  }

  /** The error in this backend's own shape, for a route to throw. */
  toHttpException(detail: { retryAfterSeconds?: number } = {}): HttpException {
    return fintavaErrorToHttp(this, detail);
  }
}

// ---------------------------------------------------------------------------
// Reading Fintava's error bodies
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function texts(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/**
 * Fintava's messages, whatever the shape (`sandbox/24-`):
 * - business errors `{ status, timestamp, message: [string], path }`;
 * - validation errors with the NestJS object nested,
 *   `{ status, timestamp, message: { statusCode, message: [string], error }, path }`;
 * - the documented NestJS shape `{ statusCode, message: string | [string], error }`;
 * - a 2xx failure such as `{ status: 200, message: "service not currently available" }`.
 * `nested` is true for the validation shape. `path` is ignored on purpose: it
 * echoes the query, which can hold a BVN or a phone.
 */
export function readFintavaMessages(body: unknown): {
  messages: string[];
  nested: boolean;
} {
  if (!isRecord(body)) return { messages: [], nested: false };
  const m = body.message;
  if (isRecord(m)) return { messages: texts(m.message), nested: true };
  return { messages: texts(m), nested: false };
}

/** Longest run of characters, from 8 up, that the text shares with a secret. */
function maskSecretRuns(text: string, secret: string): string {
  const MIN = 8;
  if (secret.length < MIN) {
    return secret.length > 0 ? text.split(secret).join('[secret]') : text;
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    let len = 0;
    const head = text.slice(i, i + MIN);
    if (head.length === MIN && secret.includes(head)) {
      len = MIN;
      while (
        i + len < text.length &&
        secret.includes(text.slice(i, i + len + 1))
      ) {
        len += 1;
      }
    }
    if (len >= MIN) {
      out += '[secret]';
      i += len;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Masks what could identify a person or open the account in a text Fintava
 * sent: any run of 8 or more characters of a given secret (the API key)
 * first, then any `Bearer` token, then any run of 40 or more base64
 * characters (an image: a selfie or a BVN photo echoed back, KYC-02), then
 * runs of 7 or more digits keep their last 4 (a BVN, NIN, phone or account
 * number), and an email keeps its domain. Also caps the length.
 */
export function maskFintavaText(text: string, secrets: string[] = []): string {
  let out = text.slice(0, 2000);
  for (const secret of secrets) out = maskSecretRuns(out, secret);
  return out
    .replace(/bearer\s+\S+/gi, '[credential]')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[data]')
    .replace(/\d{7,}/g, (d) => `${'*'.repeat(d.length - 4)}${d.slice(-4)}`)
    .replace(/[^\s@"']+@([^\s@"']+)/g, '***@$1')
    .slice(0, 200);
}

const AUTH = /invalid api key|api key is required/i;
const RULES: Array<[RegExp, FintavaErrorKind]> = [
  [/merchant is not active/i, 'merchant_inactive'],
  [/insufficient balance/i, 'insufficient_funds'],
  [/confirm both customer accounts are active/i, 'wallet_inactive'],
  [/reference already exists/i, 'duplicate_reference'],
  [/unable to find customers/i, 'payouts_blocked'],
  [/amount is less than/i, 'below_minimum'],
  [/blacklisted/i, 'identity_refused'],
];

/**
 * Classifies a failed answer. Order matters: the key first (a wrong key is
 * a 400 or a 404, and must never read as "not found" or as the user's
 * mistake), then rate limits and 5xx, then the message.
 */
export function classifyFintavaFailure(args: {
  httpStatus: number;
  body: unknown;
  call: FintavaCallKind;
  /** Removed from the messages before anything else (the API key). */
  secrets?: string[];
}): { kind: FintavaErrorKind; messages: string[] } {
  const { messages: raw, nested } = readFintavaMessages(args.body);
  const messages = raw.map((m) => maskFintavaText(m, args.secrets));
  const all = raw.join(' | ');
  const status = args.httpStatus;
  const kind = ((): FintavaErrorKind => {
    if (status === 401 || AUTH.test(all)) return 'auth';
    if (status === 429) return 'rate_limited';
    if (status >= 500) {
      return args.call === 'write' ? 'outcome_unknown' : 'unavailable';
    }
    // A 404 that is not Fintava's own JSON refusal (an empty or HTML body, a
    // gateway page, a framework "Cannot GET ...") says nothing about the
    // money or the record: unknown, never "not found".
    if (
      status === 404 &&
      (raw.length === 0 || /^cannot (get|post|put|patch|delete)\b/i.test(all))
    ) {
      return args.call === 'write' ? 'outcome_unknown' : 'unavailable';
    }
    for (const [re, k] of RULES) if (re.test(all)) return k;
    if (nested) return 'validation';
    if (args.call === 'check' && status >= 400) return 'identity_refused';
    if (
      status === 404 ||
      /not found|does not exist|no wallet exists/i.test(all)
    ) {
      return 'not_found';
    }
    if (status >= 200 && status < 300) {
      return args.call === 'write' ? 'not_confirmed' : 'bad_response';
    }
    return 'refused';
  })();
  return { kind, messages };
}

// ---------------------------------------------------------------------------
// Into this backend's error shape (docs/contract/CONVENTIONS.md section 3)
// ---------------------------------------------------------------------------

/**
 * A FintavaError as the error a route answers with. Money conditions use the
 * money envelope (`MoneyError`, with `reason.code`); an identity refusal,
 * which has no money code, is a plain 422 in the backend's usual envelope.
 * Messages are plain sentences: no provider name, no Fintava text (its
 * responses can carry a customer's BVN and NIN), no em-dash.
 *
 * A route that moves money handles `outcome_unknown` and `not_confirmed`
 * itself (the send is pending until reconciled); mapped here they say so.
 */
export function fintavaErrorToHttp(
  error: FintavaError,
  detail: { retryAfterSeconds?: number } = {},
): HttpException {
  // One mapping for every provider (MONEY-20): the neutral one, with
  // Fintava's default wait.
  return walletProviderErrorToHttp(error.kind, {
    retryAfterSeconds:
      detail.retryAfterSeconds ?? FINTAVA_DEFAULTS.retryAfterSeconds,
  });
}
