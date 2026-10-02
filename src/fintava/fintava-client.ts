import { inspect } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FintavaAmountError,
  fintavaAmountToKobo,
  fintavaAmountToKoboOrNull,
  koboToFintavaAmount,
} from './fintava-amount';
import {
  FINTAVA_CONFIG_KEYS,
  fintavaIsUnconfigured,
  readFintavaSettings,
  unconfiguredFintavaSettings,
  type FintavaSettings,
} from './fintava-config';
import {
  classifyFintavaFailure,
  FintavaError,
  maskFintavaText,
  type FintavaCallKind,
  type FintavaErrorKind,
} from './fintava-error';
import { decideFintavaRetry } from './fintava-reconcile';
import type {
  FintavaAirtimeInput,
  FintavaBank,
  FintavaBankAccountName,
  FintavaBankTransferInput,
  FintavaBillReceipt,
  FintavaBvnIdentity,
  FintavaCablePlan,
  FintavaCableInput,
  FintavaCableProvider,
  FintavaCreateCustomerInput,
  FintavaCustomer,
  FintavaCustomerHistoryQuery,
  FintavaDataBundle,
  FintavaDataInput,
  FintavaDisco,
  FintavaElectricityInput,
  FintavaEnvironment,
  FintavaLookup,
  FintavaMerchantBalance,
  FintavaMerchantBankTransferInput,
  FintavaMerchantHistoryQuery,
  FintavaMeterPreview,
  FintavaMeterPreviewInput,
  FintavaNetwork,
  FintavaPage,
  FintavaReconciliation,
  FintavaRetryOutcome,
  FintavaSelfieInput,
  FintavaSelfieResult,
  FintavaSendKind,
  FintavaSender,
  FintavaTransaction,
  FintavaTransferReceipt,
  FintavaWalletAccountName,
  FintavaWalletBalance,
  FintavaWalletState,
  FintavaWalletTransferInput,
} from './fintava.interface';

// ---------------------------------------------------------------------------
// Reading Fintava's bodies from `unknown`
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
type Scalars = Record<string, string | number | boolean | null>;

/** A 2xx body that is not the shape we read. Turned into a FintavaError. */
class FintavaShapeError extends Error {}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new FintavaShapeError(`${what} is not an object`);
  return v;
}
function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new FintavaShapeError(`${key} is missing`);
}
function strOrNull(o: Obj, key: string): string | null {
  const v = o[key];
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function bool(o: Obj, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new FintavaShapeError(`${key} is missing`);
  return v;
}
function count(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new FintavaShapeError('a page count is not a whole number');
  }
  return n;
}
/** Scalar fields only, minus anything that names an identity document. */
function scalars(o: Obj): Scalars {
  const out: Scalars = {};
  for (const [k, v] of Object.entries(o)) {
    if (/bvn|nin|image|photo|dob|birth|address/i.test(k)) continue;
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Reading a selfie match's 2xx answer (KYC-02), failing closed.
 *
 * Fintava documents no verdict field: the reference page's 200 example is
 * `{}` with an empty schema, and the success body is unseen (mobile repo
 * `docs/fintava/naira-api.md`, question 6; a failed match is a 400,
 * `sandbox/05-bvn-selfie.md`). So a match is never assumed from a 2xx. It
 * is a match only when one of SELFIE_PASS_KEYS, in `data` or one object
 * below it, is the boolean `true`, and nothing anywhere in the answer says
 * otherwise. Until Fintava shows its real success body (and these names are
 * narrowed to its field), every answer it is documented to give is read as
 * having no verdict, so no selfie passes.
 *
 * Three readings:
 * - match: as above.
 * - no match (`matched: false`, a failed match the caller counts): a field
 *   whose name says match or verif set to `false`, `0` or a word like
 *   "false", "no" or "failed"; a `status`, `result`, `outcome` or `state`
 *   that is `false` or says it failed; or `success: false`, anywhere in the
 *   answer, the envelope included.
 * - no verdict (everything else: `{}`, `match: null`, `match: "yes"`, a
 *   verdict under an unknown name only, a score alone, a status that is
 *   neither a success nor a failure): a FintavaShapeError, which the client
 *   turns into `bad_response`. The selfie service counts it (it was
 *   charged) and answers 503; it never sets a match.
 */
const SELFIE_PASS_KEYS = [
  'match',
  'matched',
  'is_match',
  'isMatch',
  'face_match',
  'faceMatch',
  'selfie_match',
  'selfieMatch',
];
/** Any field named like a verdict: each one must be `true` for a match. */
const SELFIE_VERDICT_NAME = /match|verif/i;
/** Fields that report how the call went, in the envelope or in `data`. */
const SELFIE_STATUS_NAME = /^(status|result|outcome|state)$/i;
const SELFIE_SUCCESS_NAME = /^(success|successful|is_success|isSuccess)$/i;
const SELFIE_FAILED_WORD =
  /^(false|no|n|0|fail|failed|failure|mismatch|mismatched|unmatched|not[ _-]?match(ed)?|no[ _-]?match|rejected|declined|unverified|not[ _-]?verified|invalid)$/i;
const SELFIE_SUCCESS_WORD =
  /^(success|successful|ok|matched|match|verified|passed|completed|approved|true)$/i;
const SELFIE_SCORE_KEYS = [
  'confidence',
  'confidence_value',
  'confidenceValue',
  'confidence_score',
  'confidenceScore',
  'similarity',
  'score',
];
/** How deep the answer is read for a verdict that says no. */
const SELFIE_MAX_DEPTH = 8;

type Field = { key: string; value: unknown };

/** Every scalar in `v`, with the name of the field it sits under. */
function selfieFields(v: unknown, key = '', depth = 0, out: Field[] = []) {
  if (depth > SELFIE_MAX_DEPTH) return out;
  if (Array.isArray(v)) {
    for (const item of v) selfieFields(item, key, depth + 1, out);
  } else if (isObj(v)) {
    for (const [k, item] of Object.entries(v)) {
      selfieFields(item, k, depth + 1, out);
    }
  } else {
    out.push({ key, value: v });
  }
  return out;
}

function saysFailed(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === 'string' && SELFIE_FAILED_WORD.test(value.trim());
}

function readSelfieResult(data: Obj, body: Obj): FintavaSelfieResult {
  const levels = [data, ...Object.values(data).filter(isObj)];
  let confidence: number | null = null;
  for (const o of levels) {
    for (const k of SELFIE_SCORE_KEYS) {
      const raw = o[k];
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (confidence === null && Number.isFinite(n)) confidence = n;
    }
  }

  // The whole answer, the envelope included, is read for anything that
  // says no; the envelope's `data` is read as part of it.
  const fields = selfieFields(body);
  const verdicts = fields.filter((f) => SELFIE_VERDICT_NAME.test(f.key));
  const statuses = fields.filter((f) => SELFIE_STATUS_NAME.test(f.key));
  const successFlags = fields.filter((f) => SELFIE_SUCCESS_NAME.test(f.key));

  const no =
    verdicts.some((f) => saysFailed(f.value)) ||
    statuses.some(
      (f) =>
        f.value === false ||
        (typeof f.value === 'string' &&
          SELFIE_FAILED_WORD.test(f.value.trim())),
    ) ||
    successFlags.some((f) => f.value === false);
  if (no) return { matched: false, confidence };

  const yes =
    levels.some((o) => SELFIE_PASS_KEYS.some((k) => o[k] === true)) &&
    verdicts.every((f) => f.value === true) &&
    statuses.every(
      (f) =>
        f.value === true ||
        (typeof f.value === 'number' && f.value >= 200 && f.value < 300) ||
        (typeof f.value === 'string' &&
          SELFIE_SUCCESS_WORD.test(f.value.trim())),
    ) &&
    successFlags.every((f) => f.value === true);
  if (yes) return { matched: true, confidence };

  throw new FintavaShapeError('the selfie answer carries no match verdict');
}

function readTransaction(v: unknown): FintavaTransaction {
  const o = obj(v, 'transaction');
  const customer = isObj(o.customer) ? o.customer : null;
  return {
    id: str(o, 'id'),
    createdAt: str(o, 'createdAt'),
    updatedAt: strOrNull(o, 'updatedAt') ?? str(o, 'createdAt'),
    amountKobo: fintavaAmountToKobo(o.amount),
    transType: str(o, 'transType'),
    entry: strOrNull(o, 'entry') ?? '',
    status: str(o, 'status'),
    customerReference: strOrNull(o, 'CustomerReference'),
    fintavaReference: strOrNull(o, 'reference'),
    tagapayTransRef: strOrNull(o, 'tagapayTransRef'),
    narration: strOrNull(o, 'narration'),
    senderDetails: strOrNull(o, 'senderDetails'),
    recipientDetails: strOrNull(o, 'recipientDetails'),
    senderBank: strOrNull(o, 'senderBank'),
    receiverBank: strOrNull(o, 'receiverBank'),
    sessionId: strOrNull(o, 'sessionId'),
    customerId: customer ? strOrNull(customer, 'id') : null,
    platformCommKobo: fintavaAmountToKoboOrNull(o.platformComm),
    merchantCommKobo: fintavaAmountToKoboOrNull(o.merchantComm),
    lomaChargeKobo: fintavaAmountToKoboOrNull(o.lomaCharge),
    meterToken: strOrNull(o, 'metertoken'),
    meterNumber: strOrNull(o, 'meternumber'),
    discoRef: strOrNull(o, 'discoRef'),
  };
}

/** `/txn/merchant` is `{ data: [rows], meta }`; `/txn` nests it in `data`. */
function readTransactionPage(body: unknown): FintavaPage<FintavaTransaction> {
  const top = obj(body, 'body');
  const holder = Array.isArray(top.data) ? top : obj(top.data, 'data');
  if (!Array.isArray(holder.data)) {
    throw new FintavaShapeError('the rows are missing');
  }
  const meta = obj(holder.meta, 'meta');
  return {
    items: holder.data.map(readTransaction),
    page: count(meta.page),
    take: count(meta.take),
    itemCount: count(meta.itemCount),
    pageCount: count(meta.pageCount),
    hasNextPage: meta.hasNextPage === true,
  };
}

/**
 * A customer from any of the shapes Fintava answers with (`sandbox/07-`):
 * create (`{ userInfo, wallet }`), `/customers/{id}` (record id on top,
 * `userInfo`, `wallet` beside it) and the list (the wallet inside
 * `userInfo`).
 */
function readCustomer(v: unknown, fromCreate: boolean): FintavaCustomer {
  const o = obj(v, 'customer');
  const user = obj(o.userInfo, 'userInfo');
  const wallet = obj(o.wallet ?? user.wallet, 'wallet');
  return {
    customerId: str(user, 'id'),
    walletId: str(wallet, 'id'),
    accountNumber: str(wallet, 'accountNumber'),
    recordId: fromCreate ? null : strOrNull(o, 'id'),
    tagpayCustomerId: strOrNull(wallet, 'tagpayCustomerId'),
    firstName: strOrNull(user, 'firstName') ?? '',
    lastName: strOrNull(user, 'lastName') ?? '',
    accountName: strOrNull(wallet, 'accountName') ?? '',
    isFrozen: bool(wallet, 'isFrozen'),
    walletStatus: strOrNull(wallet, 'status') ?? '',
    tier: strOrNull(wallet, 'tier'),
  };
}

function readBalance(o: Obj): FintavaWalletBalance {
  const b = obj(o.balance, 'balance');
  return {
    availableKobo: fintavaAmountToKobo(b.availableBalance),
    bookedKobo: fintavaAmountToKobo(b.bookedBalance),
    tier: strOrNull(o, 'tier'),
  };
}

function readWalletState(v: unknown): FintavaWalletState {
  const o = obj(v, 'wallet');
  return {
    walletId: str(o, 'id'),
    accountNumber: str(o, 'accountNumber'),
    isFrozen: bool(o, 'isFrozen'),
    walletStatus: strOrNull(o, 'status') ?? '',
    tier: strOrNull(o, 'tier'),
  };
}

// ---------------------------------------------------------------------------
// Input checks: refused here, before anything is sent
// ---------------------------------------------------------------------------

const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const DIGITS = /^\d+$/;

/**
 * A Nigerian mobile in the local `0...` form Fintava's create, phone check
 * and bills take. Accepts `08031234567`, `8031234567`, `2348031234567` and
 * `+2348031234567`, with spaces, dashes and brackets (CONVENTIONS.md
 * section 2).
 */
export function toFintavaLocalPhone(phone: string): string | null {
  const d = phone.replace(/[\s\-()]/g, '');
  const m = /^(?:\+?234|0)?([789][01]\d{8})$/.exec(d);
  return m ? `0${m[1]}` : null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

interface Op {
  /** A name for logs and errors. Never the URL: a query can hold a BVN. */
  name: string;
  method: 'GET' | 'POST' | 'PATCH';
  call: FintavaCallKind;
}

interface Answer {
  status: number;
  body: unknown;
}

/**
 * `/txn/merchant` is cached for about 5 minutes per `page` and `take`
 * (`sandbox/10-`), so each reconcile picks its own page size from 60 to 100:
 * a page another call just read is less likely to hide a fresh row.
 */
function historyTake(): number {
  return 60 + Math.floor(Math.random() * 41);
}
const RECONCILE_MAX_PAGES = 5;
/** History rows are compared with our send time minus this, for clock skew. */
const RECONCILE_SKEW_MS = 10 * 60_000;

/**
 * The one place this backend talks to Fintava (task MONEY-06). Bearer key,
 * no request signing. It goes beside the Flutterwave code, which it does not
 * touch; it serves no route itself (the tasks that use it, MONEY-07 onwards, do).
 *
 * Rules it keeps, each from a real sandbox answer (mobile repo
 * `docs/fintava/naira-api.md` and `sandbox/`):
 * - Every send carries OUR `CustomerReference`. A send whose answer was
 *   lost (timeout, no connection, 5xx) throws `outcome_unknown`; it is never
 *   sent again until `reconcile` has asked Fintava (the lookup by reference,
 *   then history), and only once the money timeout plus a safety window
 *   (FINTAVA_RESEND_SAFETY_MS) has passed since the first send.
 *   `retryWalletToWallet` and the bank retries do exactly that.
 * - One retry at a time per payment: the caller (MONEY-08's status check and
 *   pending sweep) must hold a lock on the payment while it calls a `retry*`
 *   method. Two bank retries running together, each with its own new
 *   reference, would both send.
 * - A 2xx is not proof: a send or purchase counts only when the body carries
 *   the transaction (`not_confirmed` otherwise).
 * - Errors are read by message as well as status (fintava-error.ts).
 * - The key is sent only to the configured Fintava host, in the
 *   Authorization header, and nowhere else: not in an error, not in a log,
 *   not in `inspect(client)`. Logs name the operation, the HTTP status, the
 *   error kind and our reference; never a URL, a body or a header.
 */
@Injectable()
export class FintavaClient {
  private readonly logger = new Logger(FintavaClient.name);
  readonly settings: FintavaSettings;
  readonly #apiKey: string;

  constructor(config: ConfigService) {
    const get = (key: string) => config.get<string>(key);
    if (fintavaIsUnconfigured(get)) {
      // Production before OPS-10: start, send nothing. The key, if one is
      // set without a base URL, is dropped so it cannot go anywhere.
      this.settings = unconfiguredFintavaSettings();
      this.#apiKey = '';
      this.logger.warn(
        `${FINTAVA_CONFIG_KEYS.baseUrl} is not set: Fintava is not configured on this server. ` +
          'Wallet routes answer 503 and nothing is sent to Fintava until it is set.',
      );
      return;
    }
    // A set value is checked here, at boot: a wrong or non-Fintava host
    // stops the app (MONEY-06).
    this.settings = readFintavaSettings(get);
    this.#apiKey = (get(FINTAVA_CONFIG_KEYS.apiKey) ?? '').trim();
  }

  get environment(): FintavaEnvironment {
    return this.settings.environment;
  }

  /** What `console.log(client)` or a logged object shows: no key. */
  [inspect.custom](): string {
    return `FintavaClient { environment: '${this.settings.environment}' }`;
  }

  toJSON(): { environment: FintavaEnvironment } {
    return { environment: this.settings.environment };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private timeoutFor(call: FintavaCallKind): number {
    if (call === 'write') return this.settings.moneyTimeoutMs;
    if (call === 'check') return this.settings.checkTimeoutMs;
    return this.settings.readTimeoutMs;
  }

  /** Fintava's texts with the key, tokens, digits and emails masked. */
  private clean(messages: string[]): string[] {
    return messages.map((m) => maskFintavaText(m, [this.#apiKey]));
  }

  private fail(
    op: Op,
    args: {
      kind: FintavaErrorKind;
      status?: number | null;
      messages?: string[];
      reference?: string | null;
      recordMayExist?: boolean;
    },
  ): FintavaError {
    const messages = this.clean(args.messages ?? []);
    const error = new FintavaError({
      kind: args.kind,
      operation: op.name,
      httpStatus: args.status ?? null,
      messages,
      reference: args.reference ?? null,
      recordMayExist: args.recordMayExist,
    });
    this.logger.warn(
      `${op.name}: ${args.kind}` +
        (error.httpStatus === null ? '' : ` HTTP ${error.httpStatus}`) +
        (error.reference ? ` ref ${error.reference}` : '') +
        (messages.length ? ` "${messages.join('; ')}"` : ''),
    );
    return error;
  }

  /**
   * One request. Returns the 2xx answer; throws a FintavaError otherwise.
   * `refusalMayLeaveRecord` marks the bank sends, whose refusals can still
   * write a PENDING record (`sandbox/14-`).
   */
  private async request(
    op: Op,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      reference?: string;
      refusalMayLeaveRecord?: boolean;
    } = {},
  ): Promise<Answer> {
    if (this.#apiKey === '' || this.settings.environment === 'unconfigured') {
      throw this.fail(op, { kind: 'not_configured' });
    }
    const url = new URL(`${this.settings.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: op.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutFor(op.call)),
        redirect: 'error',
      });
    } catch (e) {
      // No answer is not evidence about the money (a send may have landed).
      // Read by name, not instanceof: fetch's TimeoutError is a DOMException
      // from another realm under some runners.
      const why = (e as { name?: unknown } | null)?.name;
      throw this.fail(op, {
        kind: op.call === 'write' ? 'outcome_unknown' : 'unavailable',
        messages: [why === 'TimeoutError' ? 'timed out' : 'no connection'],
        reference: opts.reference,
      });
    }

    let body: unknown = null;
    try {
      const text = await res.text();
      body = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      body = null;
    }
    const ms = Date.now() - started;

    if (res.status >= 200 && res.status < 300) {
      const line =
        `${op.name}: HTTP ${res.status} in ${ms} ms` +
        (opts.reference ? ` ref ${opts.reference}` : '');
      if (op.call === 'read') this.logger.debug(line);
      else this.logger.log(line);
      return { status: res.status, body };
    }

    const { kind, messages } = classifyFintavaFailure({
      httpStatus: res.status,
      body,
      call: op.call,
      secrets: [this.#apiKey],
    });
    const quiet: FintavaErrorKind[] = [
      'auth',
      'validation',
      'rate_limited',
      'merchant_inactive',
    ];
    throw this.fail(op, {
      kind,
      status: res.status,
      messages,
      reference: opts.reference,
      recordMayExist:
        opts.refusalMayLeaveRecord && !quiet.includes(kind) ? true : undefined,
    });
  }

  /**
   * Reads a 2xx body. A shape we cannot read is `bad_response` on a read
   * and `not_confirmed` on a write (it may still have happened).
   */
  private read<T>(
    op: Op,
    answer: Answer,
    parse: (data: unknown, body: Obj) => T,
    reference?: string,
  ): T {
    try {
      const body = obj(answer.body, 'body');
      return parse(body.data, body);
    } catch (e) {
      if (!(
        e instanceof FintavaShapeError || e instanceof FintavaAmountError
      )) {
        throw e;
      }
      const { messages } = classifyFintavaFailure({
        httpStatus: answer.status,
        body: answer.body,
        call: op.call,
        secrets: [this.#apiKey],
      });
      throw this.fail(op, {
        kind: op.call === 'write' ? 'not_confirmed' : 'bad_response',
        status: answer.status,
        messages: messages.length ? messages : [maskFintavaText(e.message)],
        reference,
      });
    }
  }

  private refuse(op: Op, why: string, reference?: string): FintavaError {
    return this.fail(op, {
      kind: 'validation',
      messages: [why],
      reference: reference ?? null,
      recordMayExist: false,
    });
  }

  private amount(op: Op, kobo: number, reference?: string): number {
    try {
      return koboToFintavaAmount(kobo);
    } catch {
      throw this.refuse(op, 'amount is not a positive whole kobo', reference);
    }
  }

  private reference(op: Op, ref: string): string {
    if (!REFERENCE.test(ref)) {
      throw this.refuse(op, 'customerReference is 1 to 100 of A-Z a-z 0-9 _ -');
    }
    return ref;
  }

  private phone(op: Op, phone: string): string {
    const local = toFintavaLocalPhone(phone);
    if (!local) throw this.refuse(op, 'not a Nigerian mobile number');
    return local;
  }

  private page(q: { page?: number; take?: number }, fallbackTake = 20) {
    const page = q.page ?? 1;
    const take = q.take ?? fallbackTake;
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError('page starts at 1');
    }
    if (!Number.isInteger(take) || take < 1 || take > 100) {
      throw new RangeError('take is 1 to 100');
    }
    return { page, take };
  }

  // -------------------------------------------------------------------------
  // 1. Identity checks. Each is charged, even when it says no.
  // -------------------------------------------------------------------------

  /** `GET /compliance/verify/bvn`. Charged. An unknown BVN is `identity_refused`. */
  async verifyBvn(bvn: string): Promise<FintavaBvnIdentity> {
    const op: Op = { name: 'verify BVN', method: 'GET', call: 'check' };
    if (!/^\d{11}$/.test(bvn)) throw this.refuse(op, 'a BVN is 11 digits');
    const answer = await this.request(op, '/compliance/verify/bvn', {
      query: { bvn },
    });
    return this.read(op, answer, (data) => {
      const d = obj(data, 'data');
      return {
        firstName: strOrNull(d, 'first_name'),
        middleName: strOrNull(d, 'middle_name'),
        lastName: strOrNull(d, 'last_name'),
        dateOfBirth: strOrNull(d, 'date_of_birth'),
        phone: strOrNull(d, 'phone_number1'),
        gender: strOrNull(d, 'gender'),
        imageBase64: strOrNull(d, 'image'),
      };
    });
  }

  /**
   * `POST /compliance/verify/bvn/selfie`. Charged (₦10 in the sandbox), even
   * for a failed match, which is a 400 (`identity_refused`).
   */
  async verifyBvnSelfie(
    input: FintavaSelfieInput,
  ): Promise<FintavaSelfieResult> {
    const op: Op = { name: 'verify BVN selfie', method: 'POST', call: 'check' };
    if (!/^\d{11}$/.test(input.bvn))
      throw this.refuse(op, 'a BVN is 11 digits');
    if (input.imageBase64 === '' || input.imageBase64.startsWith('data:')) {
      throw this.refuse(op, 'the image is plain base64');
    }
    const answer = await this.request(op, '/compliance/verify/bvn/selfie', {
      body: { bvn: input.bvn, image: input.imageBase64 },
    });
    return this.read(op, answer, (data, body) =>
      readSelfieResult(obj(data, 'data'), body),
    );
  }

  /** `GET /compliance/verify/phone-number`. Charged, even for "not found". */
  async verifyPhone(phone: string): Promise<Scalars> {
    const op: Op = { name: 'verify phone', method: 'GET', call: 'check' };
    const local = this.phone(op, phone);
    const answer = await this.request(op, '/compliance/verify/phone-number', {
      query: { phone_number: local },
    });
    return this.read(op, answer, (data) => scalars(obj(data, 'data')));
  }

  // -------------------------------------------------------------------------
  // 2. Customers
  // -------------------------------------------------------------------------

  /**
   * `POST /create/customer` (answers 201). Runs no identity check of its own
   * and costs nothing; our backend checks the BVN and selfie first. A lost
   * answer is `outcome_unknown`: find the customer by phone before trying
   * again.
   */
  async createCustomer(
    input: FintavaCreateCustomerInput,
  ): Promise<FintavaCustomer> {
    const op: Op = { name: 'create customer', method: 'POST', call: 'write' };
    const phoneNumber = this.phone(op, input.phone);
    if (!/^\d{11}$/.test(input.bvn))
      throw this.refuse(op, 'a BVN is 11 digits');
    if (!/^\d{11}$/.test(input.nin))
      throw this.refuse(op, 'a NIN is 11 digits');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)) {
      throw this.refuse(op, 'dateOfBirth is YYYY-MM-DD');
    }
    const answer = await this.request(op, '/create/customer', {
      body: {
        firstName: input.firstName,
        lastName: input.lastName,
        phoneNumber,
        email: input.email,
        fundingMethod: 'STATIC_FUND',
        address: input.address,
        dateOfBirth: input.dateOfBirth,
        bvn: input.bvn,
        nin: input.nin,
      },
    });
    return this.read(op, answer, (data) => readCustomer(data, true));
  }

  /** `GET /customers/{customerId}`, with the wallet and its tier. */
  async getCustomer(customerId: string): Promise<FintavaCustomer> {
    const op: Op = { name: 'get customer', method: 'GET', call: 'read' };
    const answer = await this.request(
      op,
      `/customers/${encodeURIComponent(customerId)}`,
    );
    return this.read(op, answer, (data) => readCustomer(data, false));
  }

  /**
   * `GET /customers/details?phone=`, then the customer by id (the details
   * answer has no wallet). Null when Fintava has no such customer.
   */
  async findCustomerByPhone(phone: string): Promise<FintavaCustomer | null> {
    const op: Op = { name: 'find customer', method: 'GET', call: 'read' };
    const local = this.phone(op, phone);
    let answer: Answer;
    try {
      answer = await this.request(op, '/customers/details', {
        query: { phone: local },
      });
    } catch (e) {
      if (e instanceof FintavaError && e.kind === 'not_found') return null;
      throw e;
    }
    const customerId = this.read(op, answer, (data) => {
      if (data === null || data === undefined) return null;
      return str(obj(obj(data, 'data').userInfo, 'userInfo'), 'id');
    });
    return customerId === null ? null : this.getCustomer(customerId);
  }

  /** `GET /customers/list`, newest first. */
  async listCustomers(
    q: { page?: number; take?: number } = {},
  ): Promise<FintavaPage<FintavaCustomer>> {
    const op: Op = { name: 'list customers', method: 'GET', call: 'read' };
    const answer = await this.request(op, '/customers/list', {
      query: this.page(q),
    });
    return this.read(op, answer, (data, body) => {
      if (!Array.isArray(data)) throw new FintavaShapeError('rows missing');
      const meta = obj(body.meta, 'meta');
      return {
        items: data.map((row) => readCustomer(row, false)),
        page: count(meta.page),
        take: count(meta.take),
        itemCount: count(meta.itemCount),
        pageCount: count(meta.pageCount),
        hasNextPage: meta.hasNextPage === true,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 3. Balances: always Fintava's, never summed from our records
  // -------------------------------------------------------------------------

  /** `GET /customer/wallet/balance/{walletId}`. Readable while frozen. */
  async getWalletBalance(walletId: string): Promise<FintavaWalletBalance> {
    const op: Op = { name: 'wallet balance', method: 'GET', call: 'read' };
    const answer = await this.request(
      op,
      `/customer/wallet/balance/${encodeURIComponent(walletId)}`,
    );
    return this.read(op, answer, (data) => readBalance(obj(data, 'data')));
  }

  /** `GET /merchant/balance`: WAWU's own wallet, with its account number. */
  async getMerchantBalance(): Promise<FintavaMerchantBalance> {
    const op: Op = { name: 'merchant balance', method: 'GET', call: 'read' };
    const answer = await this.request(op, '/merchant/balance');
    return this.read(op, answer, (data) => {
      const d = obj(data, 'data');
      return {
        ...readBalance(d),
        accountName: str(d, 'accountName'),
        accountNumber: str(d, 'accountNumber'),
      };
    });
  }

  // -------------------------------------------------------------------------
  // 4. History. Debits only: money received never appears (`sandbox/09-`),
  //    and `/txn/merchant` is cached for about 5 minutes per page and take.
  // -------------------------------------------------------------------------

  /** `GET /txn?customerId=`: the customer's own debits. */
  async getCustomerHistory(
    q: FintavaCustomerHistoryQuery,
  ): Promise<FintavaPage<FintavaTransaction>> {
    const op: Op = { name: 'customer history', method: 'GET', call: 'read' };
    const answer = await this.request(op, '/txn', {
      query: { customerId: q.customerId, ...this.page(q), status: q.status },
    });
    return this.read(op, answer, (_data, body) => readTransactionPage(body));
  }

  /** `GET /txn/merchant`: WAWU's debits, compliance charges included. */
  async getMerchantHistory(
    q: FintavaMerchantHistoryQuery = {},
  ): Promise<FintavaPage<FintavaTransaction>> {
    const op: Op = { name: 'merchant history', method: 'GET', call: 'read' };
    const answer = await this.request(op, '/txn/merchant', {
      query: {
        ...this.page(q),
        status: q.status,
        startDate: q.startDate,
        endDate: q.endDate,
        order: q.order ?? 'DESC',
      },
    });
    return this.read(op, answer, (_data, body) => readTransactionPage(body));
  }

  // -------------------------------------------------------------------------
  // 5 and 6. Banks and account names
  // -------------------------------------------------------------------------

  /** `GET /banks`: one unpaged list. Key on `code`; names repeat. */
  async listBanks(): Promise<FintavaBank[]> {
    const op: Op = { name: 'list banks', method: 'GET', call: 'read' };
    const answer = await this.request(op, '/banks');
    return this.read(op, answer, (data) => {
      if (!Array.isArray(data)) throw new FintavaShapeError('rows missing');
      const seen = new Set<string>();
      const banks: FintavaBank[] = [];
      for (const row of data) {
        const o = obj(row, 'bank');
        const code = str(o, 'code');
        if (seen.has(code)) continue;
        seen.add(code);
        banks.push({ code, name: str(o, 'name') });
      }
      return banks;
    });
  }

  /**
   * `GET /name/enquiry`: the name on an account at another bank. Free. A
   * name that does not match is `matched: false`, not an error. A match here
   * does not promise a bank send will work (question 17).
   */
  async bankNameEnquiry(
    accountNumber: string,
    sortCode: string,
  ): Promise<FintavaBankAccountName> {
    const op: Op = { name: 'bank name enquiry', method: 'GET', call: 'read' };
    if (!DIGITS.test(accountNumber) || !DIGITS.test(sortCode)) {
      throw this.refuse(op, 'account number and sort code are digits');
    }
    const answer = await this.request(op, '/name/enquiry', {
      query: { accountNumber, sortCode },
    });
    return this.read(op, answer, (data) => {
      const d = obj(data, 'data');
      const account = isObj(d.account) ? d.account : {};
      const responseCode = strOrNull(account, 'responseCode');
      return {
        matched: d.status === true && responseCode === '00',
        accountName: strOrNull(account, 'accountName'),
        accountNumber: strOrNull(account, 'accountNumber') ?? accountNumber,
        bankCode: strOrNull(account, 'bankCode') ?? sortCode,
        responseCode,
      };
    });
  }

  /**
   * `GET /loma-name/enquiry`: the name on a Fintava wallet. Free. Null when
   * there is no such wallet: Fintava answers that with a 400 carrying a
   * leaked JavaScript error (`sandbox/03-`), which is never shown to anyone.
   */
  async walletNameEnquiry(
    accountNumber: string,
  ): Promise<FintavaWalletAccountName | null> {
    const op: Op = { name: 'wallet name enquiry', method: 'GET', call: 'read' };
    if (!DIGITS.test(accountNumber)) {
      throw this.refuse(op, 'an account number is digits');
    }
    let answer: Answer;
    try {
      answer = await this.request(op, '/loma-name/enquiry', {
        query: { accountNumber },
      });
    } catch (e) {
      if (
        e instanceof FintavaError &&
        (e.kind === 'refused' || e.kind === 'not_found')
      ) {
        return null;
      }
      throw e;
    }
    return this.read(op, answer, (data) => {
      const d = obj(data, 'data');
      return {
        accountNumber: str(d, 'accountNumber'),
        accountName: str(d, 'accountName'),
      };
    });
  }

  // -------------------------------------------------------------------------
  // 8. Lookups
  // -------------------------------------------------------------------------

  /**
   * `GET /transaction/reference/{ref}`, by OUR reference (or Fintava's
   * `reference`; never a transfer response's `reference` field, which is
   * not findable). Three answers: found, absent (404), unknown (200 `{}`).
   */
  /**
   * A failed lookup: absent only for Fintava's own JSON refusal
   * `404 "Transaction not found!"` (`sandbox/11-`). Any other 404 (a
   * framework "Cannot GET", an empty or HTML body, a gateway page, another
   * message) says nothing about the send: `outcome_unknown`, so nothing is
   * ever sent again on it.
   */
  private lookupFailure(op: Op, e: unknown, reference?: string): FintavaLookup {
    if (!(e instanceof FintavaError) || e.httpStatus !== 404) throw e;
    if (e.kind === 'auth' || e.kind === 'not_configured') throw e;
    if (
      e.kind === 'not_found' &&
      e.messages.length === 1 &&
      /^transaction not found!?$/i.test(e.messages[0].trim())
    ) {
      return { state: 'absent' };
    }
    throw this.fail(op, {
      kind: 'outcome_unknown',
      status: 404,
      messages: e.messages.length ? e.messages : ['a 404 that is not Fintava'],
      reference: reference ?? null,
      recordMayExist: true,
    });
  }

  async getTransactionByReference(reference: string): Promise<FintavaLookup> {
    const op: Op = {
      name: 'transaction by reference',
      method: 'GET',
      call: 'read',
    };
    let answer: Answer;
    try {
      answer = await this.request(
        op,
        `/transaction/reference/${encodeURIComponent(reference)}`,
        { reference },
      );
    } catch (e) {
      return this.lookupFailure(op, e, reference);
    }
    return this.read(
      op,
      answer,
      (data) => {
        if (data === undefined || data === null) return { state: 'unknown' };
        const transaction = readTransaction(data);
        if (
          transaction.customerReference !== reference &&
          transaction.fintavaReference !== reference
        ) {
          throw new FintavaShapeError('the record is for another reference');
        }
        return { state: 'found', transaction };
      },
      reference,
    );
  }

  /**
   * `GET /transaction/id/{id}`: the full record, fees and bill fields
   * included. An unknown id is a 200 with `data: null` (absent). The
   * customer identity it embeds is dropped. Like the lookup by reference it
   * can answer `{}` for a record that exists, so a resend is never decided
   * from this call: `reconcile` does not use it.
   */
  async getTransactionById(id: string): Promise<FintavaLookup> {
    const op: Op = { name: 'transaction by id', method: 'GET', call: 'read' };
    let answer: Answer;
    try {
      answer = await this.request(
        op,
        `/transaction/id/${encodeURIComponent(id)}`,
      );
    } catch (e) {
      return this.lookupFailure(op, e);
    }
    return this.read(op, answer, (data, body) => {
      if (data === null) return { state: 'absent' };
      if (data === undefined || !('data' in body)) return { state: 'unknown' };
      return { state: 'found', transaction: readTransaction(data) };
    });
  }

  // -------------------------------------------------------------------------
  // 9 and 10. Wallet to wallet (customer to customer, WAWU to a customer,
  //           a customer to WAWU)
  // -------------------------------------------------------------------------

  private readReceipt(
    op: Op,
    answer: Answer,
    customerReference: string,
  ): FintavaTransferReceipt {
    return this.read(
      op,
      answer,
      (data) => {
        const d = obj(data, 'data');
        const amountKobo = fintavaAmountToKobo(d.amount);
        return {
          customerReference,
          // Swapped on the wire (`sandbox/11-`): the response's
          // `customerReference` is Fintava's findable `reference`, and its
          // `reference` is the unfindable `tagapayTransRef`.
          fintavaReference: str(d, 'customerReference'),
          tagapayTransRef: str(d, 'reference'),
          transactionId: strOrNull(d, 'id'),
          amountKobo,
          totalKobo: fintavaAmountToKoboOrNull(d.total) ?? amountKobo,
          feeKobo: fintavaAmountToKoboOrNull(d.transaction_fee) ?? 0,
          lomaChargeKobo: fintavaAmountToKoboOrNull(d.lomaCharge),
          sourceAccountNumber: strOrNull(d, 'source_customer_accno'),
          sourceAvailableKobo: fintavaAmountToKoboOrNull(
            d.source_availableBalance,
          ),
          sourceBookedKobo: fintavaAmountToKoboOrNull(d.source_bookedBalance),
        };
      },
      customerReference,
    );
  }

  /**
   * `POST /transaction/wallet-to-wallet` (never the deprecated
   * `/single/transfer`). One attempt. A lost answer is `outcome_unknown`:
   * use `retryWalletToWallet`, which reconciles before sending again. A
   * repeated reference is `duplicate_reference`; a frozen sender or
   * receiver is `wallet_inactive`.
   */
  async walletToWallet(
    input: FintavaWalletTransferInput,
  ): Promise<FintavaTransferReceipt> {
    const op: Op = { name: 'wallet to wallet', method: 'POST', call: 'write' };
    const ref = this.reference(op, input.customerReference);
    if (
      !DIGITS.test(input.senderAccountNumber) ||
      !DIGITS.test(input.receiverAccountNumber)
    ) {
      throw this.refuse(op, 'account numbers are digits', ref);
    }
    if (input.senderAccountNumber === input.receiverAccountNumber) {
      throw this.refuse(op, 'sender and receiver are the same wallet', ref);
    }
    const answer = await this.request(op, '/transaction/wallet-to-wallet', {
      body: {
        senderAccount: input.senderAccountNumber,
        receiverAccount: input.receiverAccountNumber,
        amount: this.amount(op, input.amountKobo, ref),
        narration: input.narration,
        CustomerReference: ref,
      },
      reference: ref,
    });
    return this.readReceipt(op, answer, ref);
  }

  // -------------------------------------------------------------------------
  // 7. Bank sends. Every refusal may still leave a PENDING record and use
  //    the reference up (`sandbox/14-`): retry only under a new reference.
  // -------------------------------------------------------------------------

  /** `POST /bank/credit`: a customer's wallet to a bank account. */
  async bankTransfer(
    input: FintavaBankTransferInput,
  ): Promise<FintavaTransferReceipt> {
    const op: Op = { name: 'bank transfer', method: 'POST', call: 'write' };
    const ref = this.reference(op, input.customerReference);
    if (!DIGITS.test(input.accountNumber) || !DIGITS.test(input.sortCode)) {
      throw this.refuse(op, 'account number and sort code are digits', ref);
    }
    const answer = await this.request(op, '/bank/credit', {
      body: {
        sourceId: input.sourceCustomerId,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        sortCode: input.sortCode,
        amount: this.amount(op, input.amountKobo, ref),
        narration: input.narration,
        CustomerReference: ref,
      },
      reference: ref,
      refusalMayLeaveRecord: true,
    });
    return this.readReceipt(op, answer, ref);
  }

  /** `POST /bank/credit/merchant`: WAWU's merchant wallet to a bank. */
  async merchantBankTransfer(
    input: FintavaMerchantBankTransferInput,
  ): Promise<FintavaTransferReceipt> {
    const op: Op = {
      name: 'merchant bank transfer',
      method: 'POST',
      call: 'write',
    };
    const ref = this.reference(op, input.customerReference);
    if (!DIGITS.test(input.accountNumber) || !DIGITS.test(input.sortCode)) {
      throw this.refuse(op, 'account number and sort code are digits', ref);
    }
    const answer = await this.request(op, '/bank/credit/merchant', {
      body: {
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        sortCode: input.sortCode,
        amount: this.amount(op, input.amountKobo, ref),
        narration: input.narration,
        CustomerReference: ref,
      },
      reference: ref,
      refusalMayLeaveRecord: true,
    });
    return this.readReceipt(op, answer, ref);
  }

  // -------------------------------------------------------------------------
  // Reconciling a send whose answer was lost
  // -------------------------------------------------------------------------

  /**
   * The sender's history (the merchant's for WAWU's sends, the customer's for
   * a customer's), newest first, back to `since`: the row for `reference`,
   * or null. Errors propagate.
   */
  private async findInHistory(
    reference: string,
    sender: FintavaSender,
    since?: Date,
  ): Promise<FintavaTransaction | null> {
    const oldest = since ? since.getTime() - RECONCILE_SKEW_MS : null;
    const take = historyTake();
    for (let page = 1; page <= RECONCILE_MAX_PAGES; page += 1) {
      const rows =
        sender.kind === 'merchant'
          ? await this.getMerchantHistory({ page, take, order: 'DESC' })
          : await this.getCustomerHistory({
              customerId: sender.customerId,
              page,
              take,
            });
      const hit = rows.items.find((t) => t.customerReference === reference);
      if (hit) return hit;
      const last = rows.items[rows.items.length - 1];
      const pastSince =
        oldest !== null &&
        last !== undefined &&
        Date.parse(last.createdAt) < oldest;
      if (!rows.hasNextPage || pastSince || rows.items.length === 0) break;
    }
    return null;
  }

  /**
   * What Fintava knows about one of our references: the lookup by
   * reference, then the sender's history. Found in either is `found`.
   * `absent` needs both: Fintava's own `404 "Transaction not found!"` AND no
   * row in history. A lookup that answers `{}` with no row in history is
   * `unknown` (a missing row is not proof: the merchant list is cached for
   * about 5 minutes); so is any answer we cannot read or reach.
   */
  async reconcile(
    reference: string,
    sender: FintavaSender,
    since?: Date,
  ): Promise<FintavaReconciliation> {
    const passThrough = (e: unknown) =>
      !(e instanceof FintavaError) ||
      e.kind === 'auth' ||
      e.kind === 'not_configured';
    let lookup: FintavaLookup;
    try {
      lookup = await this.getTransactionByReference(reference);
    } catch (e) {
      if (passThrough(e)) throw e;
      const unrecognised =
        e instanceof FintavaError && e.kind === 'outcome_unknown';
      return {
        state: 'unknown',
        why: unrecognised ? 'unrecognised' : 'unreachable',
      };
    }
    if (lookup.state === 'found') {
      return {
        state: 'found',
        source: 'lookup',
        transaction: lookup.transaction,
      };
    }
    let row: FintavaTransaction | null;
    try {
      row = await this.findInHistory(reference, sender, since);
    } catch (e) {
      if (passThrough(e)) throw e;
      return { state: 'unknown', why: 'unreachable' };
    }
    if (row) return { state: 'found', source: 'history', transaction: row };
    return lookup.state === 'absent'
      ? { state: 'absent' }
      : { state: 'unknown', why: 'empty_lookup' };
  }

  private async decide(
    kind: FintavaSendKind,
    reference: string,
    sender: FintavaSender,
    attemptedAt: Date,
  ) {
    const reconciliation = await this.reconcile(reference, sender, attemptedAt);
    return decideFintavaRetry(kind, reconciliation, {
      attemptedAt,
      now: new Date(),
      resendAfterMs:
        this.settings.moneyTimeoutMs + this.settings.resendSafetyMs,
    });
  }

  /**
   * Callers hold a lock on the payment for the whole call (MONEY-08): this
   * method does not stop a second retry of the same payment running beside
   * it.
   *
   * The only way to send a wallet-to-wallet transfer again after
   * `outcome_unknown`: reconcile `input.customerReference` first, and send
   * again (same reference) only when Fintava says it has no such transfer.
   * Otherwise the decision says why not, and nothing is sent.
   */
  async retryWalletToWallet(
    input: FintavaWalletTransferInput,
    ctx: { sender: FintavaSender; attemptedAt: Date },
  ): Promise<FintavaRetryOutcome> {
    const decision = await this.decide(
      'wallet_to_wallet',
      input.customerReference,
      ctx.sender,
      ctx.attemptedAt,
    );
    if (decision.action !== 'resend_same_reference') {
      return { decision, receipt: null };
    }
    return { decision, receipt: await this.walletToWallet(input) };
  }

  /**
   * A customer's bank send again, after `outcome_unknown` or a refusal:
   * reconciles `previousReference` and sends `input` (which must carry a NEW
   * reference) only when the old one is failed or absent. A PENDING or
   * unknown old send is never sent again.
   */
  async retryBankTransfer(
    input: FintavaBankTransferInput,
    ctx: { previousReference: string; attemptedAt: Date },
  ): Promise<FintavaRetryOutcome> {
    this.assertNewReference(
      'bank transfer',
      input.customerReference,
      ctx.previousReference,
    );
    const decision = await this.decide(
      'bank_transfer',
      ctx.previousReference,
      { kind: 'customer', customerId: input.sourceCustomerId },
      ctx.attemptedAt,
    );
    if (decision.action !== 'resend_new_reference') {
      return { decision, receipt: null };
    }
    return { decision, receipt: await this.bankTransfer(input) };
  }

  /** As `retryBankTransfer`, for WAWU's merchant wallet. */
  async retryMerchantBankTransfer(
    input: FintavaMerchantBankTransferInput,
    ctx: { previousReference: string; attemptedAt: Date },
  ): Promise<FintavaRetryOutcome> {
    this.assertNewReference(
      'merchant bank transfer',
      input.customerReference,
      ctx.previousReference,
    );
    const decision = await this.decide(
      'bank_transfer',
      ctx.previousReference,
      { kind: 'merchant' },
      ctx.attemptedAt,
    );
    if (decision.action !== 'resend_new_reference') {
      return { decision, receipt: null };
    }
    return { decision, receipt: await this.merchantBankTransfer(input) };
  }

  private assertNewReference(name: string, next: string, previous: string) {
    if (next === previous) {
      throw this.refuse(
        { name, method: 'POST', call: 'write' },
        'a bank send is retried under a new reference',
        next,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 12. Freeze and unfreeze. A frozen wallet can neither send nor receive.
  // -------------------------------------------------------------------------

  /** `PATCH /customer/wallet/{walletId}/freeze` with a reason. */
  async freezeWallet(
    walletId: string,
    reason: string,
  ): Promise<FintavaWalletState> {
    const op: Op = { name: 'freeze wallet', method: 'PATCH', call: 'write' };
    if (reason.trim() === '') throw this.refuse(op, 'a freeze needs a reason');
    const answer = await this.request(
      op,
      `/customer/wallet/${encodeURIComponent(walletId)}/freeze`,
      { body: { reason } },
    );
    return this.read(op, answer, (data) => readWalletState(data));
  }

  /** `PATCH /customer/wallet/{walletId}/unfreeze`. No body. */
  async unfreezeWallet(walletId: string): Promise<FintavaWalletState> {
    const op: Op = { name: 'unfreeze wallet', method: 'PATCH', call: 'write' };
    const answer = await this.request(
      op,
      `/customer/wallet/${encodeURIComponent(walletId)}/unfreeze`,
    );
    return this.read(op, answer, (data) => readWalletState(data));
  }

  // -------------------------------------------------------------------------
  // 11. Bills. Paid from WAWU's merchant wallet; the calls take no customer
  //     and no CustomerReference. A purchase counts only when the body
  //     carries it: cable answered 201 "service not currently available".
  // -------------------------------------------------------------------------

  /** `GET /billing/discos`: limits are per disco; postpaid codes included. */
  async listDiscos(): Promise<FintavaDisco[]> {
    const op: Op = { name: 'list discos', method: 'GET', call: 'read' };
    const answer = await this.request(op, '/billing/discos');
    return this.read(op, answer, (data) => {
      if (!Array.isArray(data)) throw new FintavaShapeError('rows missing');
      return data.map((row) => {
        const o = obj(row, 'disco');
        return {
          code: str(o, 'code'),
          description: strOrNull(o, 'description') ?? str(o, 'code'),
          minimumKobo: fintavaAmountToKobo(o.minimum_value),
          maximumKobo: fintavaAmountToKobo(o.maximum_value),
          available: o.is_available === 'Yes',
        };
      });
    });
  }

  /**
   * `POST /billing/preview-meter`: the name on a meter. Free. Null when
   * Fintava does not recognise the meter (a bare 400 "Http Exception").
   */
  async previewMeter(
    input: FintavaMeterPreviewInput,
  ): Promise<FintavaMeterPreview | null> {
    const op: Op = { name: 'preview meter', method: 'POST', call: 'read' };
    let answer: Answer;
    try {
      answer = await this.request(op, '/billing/preview-meter', {
        body: {
          meternumber: input.meterNumber,
          disco: input.disco,
          planType: input.planType,
        },
      });
    } catch (e) {
      if (
        e instanceof FintavaError &&
        (e.kind === 'refused' || e.kind === 'not_found')
      ) {
        return null;
      }
      throw e;
    }
    return this.read(op, answer, (data) => ({
      details: scalars(obj(data, 'data')),
    }));
  }

  /**
   * Network names for the data list: 9mobile is `ETISALAT` there (`9MOBILE`
   * is a 404, `sandbox/20-`). Airtime keeps the documented `9MOBILE`.
   */
  private dataNetwork(network: FintavaNetwork): string {
    return network === '9MOBILE' ? 'ETISALAT' : network;
  }

  /** `GET /billing/data-bundles/{network}`. */
  async listDataBundles(network: FintavaNetwork): Promise<FintavaDataBundle[]> {
    const op: Op = { name: 'list data bundles', method: 'GET', call: 'read' };
    const answer = await this.request(
      op,
      `/billing/data-bundles/${encodeURIComponent(this.dataNetwork(network))}`,
    );
    return this.read(op, answer, (data) => {
      if (!Array.isArray(data)) throw new FintavaShapeError('rows missing');
      return data.map((row) => {
        const o = obj(row, 'bundle');
        return {
          code: str(o, 'code'),
          title: strOrNull(o, 'title') ?? '',
          priceKobo: fintavaAmountToKobo(o.price),
          validity: strOrNull(o, 'validity') ?? '',
        };
      });
    });
  }

  /** `GET /cable-service-name`: GOTV and DSTV. */
  async listCableProviders(): Promise<string[]> {
    const op: Op = {
      name: 'list cable providers',
      method: 'GET',
      call: 'read',
    };
    const answer = await this.request(op, '/cable-service-name');
    return this.read(op, answer, (data) => {
      if (!Array.isArray(data)) throw new FintavaShapeError('rows missing');
      return data.map((row) => str(obj(row, 'provider'), 'name'));
    });
  }

  /** `GET /cable-service-name/{provider}` (case-sensitive). */
  async listCablePlans(
    provider: FintavaCableProvider,
  ): Promise<FintavaCablePlan[]> {
    const op: Op = { name: 'list cable plans', method: 'GET', call: 'read' };
    const answer = await this.request(
      op,
      `/cable-service-name/${encodeURIComponent(provider)}`,
    );
    return this.read(op, answer, (data) => {
      if (!Array.isArray(data)) throw new FintavaShapeError('rows missing');
      return data.map((row) => {
        const o = obj(row, 'plan');
        return {
          code: str(o, 'code'),
          title: strOrNull(o, 'title') ?? '',
          provider: strOrNull(o, 'network') ?? provider,
          priceKobo: fintavaAmountToKobo(o.price),
          available: o.available === 'Yes',
        };
      });
    });
  }

  private readBill(op: Op, answer: Answer): FintavaBillReceipt {
    return this.read(op, answer, (data) => {
      const d = obj(data, 'data');
      return {
        transactionId: strOrNull(d, 'id'),
        fintavaReference: strOrNull(d, 'reference'),
        amountKobo: fintavaAmountToKoboOrNull(d.amount),
        meterToken: strOrNull(d, 'metertoken') ?? strOrNull(d, 'token'),
        details: scalars(d),
      };
    });
  }

  /** `POST /billing/electricity`, from WAWU's merchant wallet. */
  async buyElectricity(
    input: FintavaElectricityInput,
  ): Promise<FintavaBillReceipt> {
    const op: Op = { name: 'buy electricity', method: 'POST', call: 'write' };
    const answer = await this.request(op, '/billing/electricity', {
      body: {
        meternumber: input.meterNumber,
        disco: input.disco,
        amount: this.amount(op, input.amountKobo),
        planType: input.planType,
      },
    });
    return this.readBill(op, answer);
  }

  /** `POST /billing/airtime`: whole naira, at least ₦100 (`sandbox/19-`). */
  async buyAirtime(input: FintavaAirtimeInput): Promise<FintavaBillReceipt> {
    const op: Op = { name: 'buy airtime', method: 'POST', call: 'write' };
    const phone = this.phone(op, input.phone);
    if (
      !Number.isSafeInteger(input.amountKobo) ||
      input.amountKobo % 100 !== 0
    ) {
      throw this.refuse(op, 'airtime is whole naira');
    }
    if (input.amountKobo < 10_000) {
      throw this.fail(op, {
        kind: 'below_minimum',
        messages: ['Airtime amount is less than 100'],
        recordMayExist: false,
      });
    }
    const answer = await this.request(op, '/billing/airtime', {
      body: {
        vtu_network: input.network,
        vtu_amount: input.amountKobo / 100,
        vtu_number: phone,
      },
    });
    return this.readBill(op, answer);
  }

  /** `POST /billing/data-bundle`, with a code from `listDataBundles`. */
  async buyDataBundle(input: FintavaDataInput): Promise<FintavaBillReceipt> {
    const op: Op = { name: 'buy data', method: 'POST', call: 'write' };
    const phone = this.phone(op, input.phone);
    const answer = await this.request(op, '/billing/data-bundle', {
      body: {
        vtu_network: this.dataNetwork(input.network),
        data_code: input.bundleCode,
        vtu_number: phone,
      },
    });
    return this.readBill(op, answer);
  }

  /** `POST /billing/cable-subscription`: the plan code sets the price. */
  async buyCable(input: FintavaCableInput): Promise<FintavaBillReceipt> {
    const op: Op = { name: 'buy cable', method: 'POST', call: 'write' };
    const answer = await this.request(op, '/billing/cable-subscription', {
      body: {
        smartcard_number: input.smartcardNumber,
        tv_network: input.provider,
        service_code: input.planCode,
      },
    });
    return this.readBill(op, answer);
  }
}
