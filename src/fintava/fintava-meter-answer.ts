import {
  classifyFintavaFailure,
  readFintavaMessages,
  type FintavaErrorKind,
} from './fintava-error';

/**
 * How a 2xx answer to `POST /billing/preview-meter` reads (BILLS-01 round 2, D2).
 *
 * The success body has never been seen: no sandbox meter number is known (question 11). So a meter counts as found only
 * for the one shape the Hub can stand behind: a `data` object that names an owner as text under a key a person's name is
 * kept under. Nothing else is read as a person, and Fintava styles its failures inside a 2xx (`sandbox/21-`: a `201`
 * carrying `{ status: 200, message: "service not currently available" }`, and a `200` whose body says `status: 400`), so
 * those are read first.
 *
 * - `owner`: a name (and an address when the body has one).
 * - `not_found`: Fintava says there is no such meter, or answers with nothing in `data` (no one is on that meter).
 * - `service_unavailable`: Fintava says its bills service is off.
 * - `failed`: the body carries a failure status of its own (401, 403, 429, 5xx, a 400 refusal); the caller treats it as
 *   it would the same status on the wire.
 * - `unreadable`: anything else (not JSON, `data` missing or not an object, an object with no name, a name that is not
 *   text, an owner nested somewhere unknown, a name that says nobody is there, a failure flagged anywhere in the body).
 *   The Hub says it could not confirm the meter. It never guesses.
 */
export type MeterReading =
  | { kind: 'owner'; name: string; address: string | null; data: MeterData }
  | { kind: 'not_found' }
  | { kind: 'service_unavailable' }
  | {
      kind: 'failed';
      failure: FintavaErrorKind;
      status: number;
      messages: string[];
    }
  | { kind: 'unreadable' };

export type MeterData = Record<string, unknown>;

/** Spaces of every kind: the ordinary one, tabs and newlines, the no-break space, the line separator, the byte order mark. */
const SPACES = /\s+/g;
/**
 * Characters nobody can see, apart from spaces: controls, format characters (zero-width space and joiners, a soft hyphen,
 * a word joiner), the combining grapheme joiner, the Braille blank and the Hangul fillers. A name made only of these and
 * spaces is blank.
 */
const INVISIBLE = '\\p{Cc}\\p{Cf}\\u034f\\u115f\\u1160\\u2800\\u3164\\uffa0';
const HIDDEN = new RegExp(`[${INVISIBLE}]`, 'gu');
/** Reads one character: is it a space or an invisible character? Used to fill the tables below, one character at a time. */
const BLANK_CHAR = new RegExp(`^[\\s${INVISIBLE}]$`, 'u');

let blankTable: Uint8Array | null = null;
/** The characters above U+FFFF that are blank, as they are met (there are about a hundred; a visible one is never kept). */
const blankAstral = new Set<number>();

/**
 * For every UTF-16 code unit outside the surrogates, 1 when it is a space or an invisible character, 0 when a person can
 * see it. Built once, on first use, from the same pattern that defines "invisible" above, so the two cannot disagree.
 */
function blankUnits(): Uint8Array {
  if (blankTable === null) {
    const table = new Uint8Array(0x10000);
    for (let unit = 0; unit < 0x10000; unit += 1) {
      if (unit >= 0xd800 && unit <= 0xdfff) continue;
      table[unit] = BLANK_CHAR.test(String.fromCharCode(unit)) ? 1 : 0;
    }
    blankTable = table;
  }
  return blankTable;
}

/**
 * Where the first character a person can see is in `text`, or `text.length` when there is none. A plain loop with a table,
 * so a text of millions of invisible characters costs one pass and no regular expression stack. A lone surrogate counts as
 * visible, as the pattern has always read it.
 *
 * It replaces `text.replace(/^(?:\s|[invisible])+/u, '')`, which kept an entry on the regular expression engine's backtrack
 * stack for every character it matched and threw "Maximum call stack size exceeded" out of the request for a text of
 * several million of them (BILLS-01 hotfix 2: it did so on the deploy's test runner at five million).
 */
function firstVisibleIndex(text: string): number {
  const table = blankUnits();
  const length = text.length;
  let i = 0;
  while (i < length) {
    const unit = text.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) {
      if (table[unit] === 0) return i;
      i += 1;
      continue;
    }
    const point = text.codePointAt(i) ?? unit;
    if (point < 0x10000) return i;
    if (!blankAstral.has(point)) {
      if (!BLANK_CHAR.test(String.fromCodePoint(point))) return i;
      blankAstral.add(point);
    }
    i += 2;
  }
  return length;
}

/** The text with the spaces and invisible characters at its start taken off; empty when it has nothing a person can see. */
export function withoutLeadingInvisible(text: string): string {
  const at = firstVisibleIndex(text);
  return at === 0 ? text : text.slice(at);
}

/** Whether `text` holds anything a person can see (a letter, a digit, a mark), without copying it. */
export function hasVisibleText(text: string): boolean {
  return firstVisibleIndex(text) < text.length;
}

const SERVICE_OFF =
  /not currently available|service (is )?(currently |temporarily )?unavailable|(currently|temporarily) unavailable/i;
const NO_SUCH_METER = /not found|no such meter|invalid meter|does not exist/i;

/**
 * What a body can put where a person's name goes when there is no person (BILLS-01 round 4, R3-1 and R3-2). The success
 * body has never been seen, and some bill APIs answer an unknown meter with a placeholder in the name field, so a rule
 * decides, not a closed list of spellings: after taking out invisible characters, folding case and width, and reading
 * every spelling of "n/a" as `na`, the name is split into words (anything that is not a letter or a digit divides them),
 * and a name whose every word is on one of these lists says nobody:
 * - `PLACEHOLDER_WORDS`: null, none, nil, unknown, undefined, na, a failure word, the words of "no customer found",
 *   "meter not registered", "please check the meter number" and the like. A word made of digits only counts too ("0",
 *   "00", "12345"), and so does no word at all (a name of dashes, dots or marks).
 * - `COMPANY_FORM_WORDS`: what a company's name is made of apart from its own name (plc, limited, ltd, distribution,
 *   company, disco, electric, electricity, prepaid, postpaid, bill, payment, token, purchase).
 * One word of a person's name off both lists makes the name an owner ("Ada Unknown Eze", "Nil Okoro", "Anita Test").
 * The company's own words (its name, code and short names) are added by the caller that knows the company.
 */
export const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  'null',
  'none',
  'nil',
  'nill',
  'undefined',
  'unknown',
  'na',
  'nan',
  'tbd',
  'tba',
  'test',
  'user',
  'customer',
  'name',
  'unnamed',
  'nameless',
  'anonymous',
  'default',
  'empty',
  'blank',
  'missing',
  'false',
  'true',
  'object',
  'no',
  'not',
  'found',
  'unable',
  'find',
  'verify',
  'verified',
  'invalid',
  'valid',
  'inactive',
  'unavailable',
  'available',
  'applicable',
  'unregistered',
  'registered',
  'exist',
  'exists',
  'does',
  'error',
  'errors',
  'occurred',
  'fail',
  'failed',
  'failure',
  'fetch',
  'to',
  'meter',
  'number',
  'service',
  'account',
  'record',
  'records',
  'data',
  'details',
  'detail',
  'information',
  'info',
  'nothing',
  'such',
  'on',
  'file',
  'please',
  'check',
  'incorrect',
  'wrong',
  'is',
  'the',
  'a',
  'an',
  'you',
  'entered',
]);

export const COMPANY_FORM_WORDS: ReadonlySet<string> = new Set([
  'plc',
  'ltd',
  'limited',
  'company',
  'co',
  'distribution',
  'disco',
  'discos',
  'electric',
  'electricity',
  'power',
  'prepaid',
  'postpaid',
  'bill',
  'bills',
  'payment',
  'token',
  'purchase',
]);

const DIGITS_ONLY = /^\p{N}+$/u;

/** The longest stretch of a name the placeholder rule reads; a longer name has more than a placeholder in it. */
const NAME_WORDS_READ = 2000;

/** A key as compared: lower case, with every non-letter and non-digit taken out (`Customer_Name` is `customername`). */
function keyForm(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const NAME_KEYS = [
  'customername',
  'name',
  'accountname',
  'consumername',
  'fullname',
  'customerfullname',
];
const ADDRESS_KEYS = [
  'address',
  'customeraddress',
  'consumeraddress',
  'serviceaddress',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A body's own `status`, when it is a number or a number written as text. */
function statusOf(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{3}$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** The first of `keys` (in this order) that holds text a person can see in `data`, trimmed. */
function firstText(data: MeterData, keys: readonly string[]): string | null {
  const byKey = new Map<string, string>();
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && hasVisibleText(v))
      byKey.set(keyForm(k), v.trim());
  }
  for (const k of keys) {
    const v = byKey.get(k);
    if (v !== undefined) return v;
  }
  return null;
}

/** The words of a name as the placeholder rule reads them (see `PLACEHOLDER_WORDS`). */
export function nameWordsOf(name: string): string[] {
  return name
    .slice(0, NAME_WORDS_READ)
    .normalize('NFKC')
    .replace(SPACES, ' ')
    .replace(HIDDEN, '')
    .toLowerCase()
    .replace(/\bn\s*[/\\]\s*a\b|\bn\.\s*a\b/g, 'na')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

/**
 * A name that says there is no person: every word is a placeholder, a company form, a number, or one of the
 * `companyWords` the caller adds; or the name is a sentence saying there is no such meter or that the service is off.
 */
export function isNotAnOwner(
  name: string,
  companyWords: ReadonlySet<string> = new Set(),
): boolean {
  const words = nameWordsOf(name);
  if (words.length === 0) return true;
  if (NO_SUCH_METER.test(words.join(' ')) || SERVICE_OFF.test(words.join(' ')))
    return true;
  return words.every(
    (w) =>
      PLACEHOLDER_WORDS.has(w) ||
      COMPANY_FORM_WORDS.has(w) ||
      companyWords.has(w) ||
      DIGITS_ONLY.test(w),
  );
}

// ---------------------------------------------------------------------------
// A failure flagged anywhere in a body (BILLS-01 round 4, R3-2)
// ---------------------------------------------------------------------------

/** Keys that are a yes or no on whether the call worked or the meter is real; an explicit "no" is a failure. */
const YES_NO_KEYS = new Set([
  'success',
  'successful',
  'issuccess',
  'issuccessful',
  'valid',
  'isvalid',
  'verified',
  'isverified',
  'found',
  'isfound',
  'exists',
  'exist',
  'ok',
  'status',
]);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'f', 'off']);
/** Keys whose text may say the call failed. */
const SAYING_KEYS = new Set([
  'status',
  'message',
  'messages',
  'error',
  'errors',
  'errormessage',
  'errormsg',
  'reason',
]);
/** Keys that hold an error when they hold anything at all. */
const ERROR_KEYS = new Set(['error', 'errors', 'errormessage', 'errormsg']);
/** Keys that carry the call's own result code: a number, or a word for success. */
const RESULT_CODE_KEYS = new Set([
  'statuscode',
  'responsecode',
  'responsestatus',
  'httpstatus',
  'httpcode',
]);
/** `code` is a result code only as a number of up to three digits (a disco code or a customer code is something else). */
const CODE_KEYS = new Set(['code']);
const SUCCESS_WORDS = new Set([
  'success',
  'successful',
  'ok',
  'okay',
  'approved',
  'true',
  'yes',
]);

const FAILURE_WORDS =
  /\b(?:fail(?:ed|ure|ures|s)?|errors?|invalid|unable|unsuccessful(?:ly)?|unauthori[sz]ed|forbidden|denied|reject(?:ed)?|declin(?:ed|e)|refus(?:ed|al)|inactive|expired|exception|bad request|time(?:d)? ?out|not (?:found|available|registered|valid|successful)|unavailable|no such|(?:does|did) not exist|doesn['’]?t exist|could not|couldn['’]?t|cannot|can['’]?t)\b/i;

/** How deep into the body, and how far into a list, a failure flag is looked for. */
const FLAG_DEPTH = 4;
const FLAG_LIST = 10;

/** An explicit "no" (JavaScript's false, 0, or the text "false", "0", "no" in any case). */
function saysNo(v: unknown): boolean {
  if (v === false || v === 0) return true;
  return typeof v === 'string' && FALSE_WORDS.has(v.trim().toLowerCase());
}

/** A text (or a list of texts) that names a failure. */
function saysFailure(v: unknown): boolean {
  if (typeof v === 'string') return FAILURE_WORDS.test(v);
  return Array.isArray(v) && v.slice(0, FLAG_LIST).some(saysFailure);
}

/** Anything at all in a place that holds an error: true, a non-empty text, a number but 0, a list or object with something in. */
function holdsSomething(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

/** A result code of up to three digits (a number, or text of digits), or null. */
function codeOf(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1000
    ? n
    : null;
}

/** A code from 400 up is a failure, and so is a small one other than 0 ("01", "99"): 200 to 399 is a success. */
function failedCode(n: number): boolean {
  return n >= 400 || (n >= 1 && n < 200);
}

/**
 * Whether an object, or anything nested in it, flags a failure: an explicit no under `success`, `valid`, `found`, `ok`
 * or `status`; a `status` or `message` or `error` that says failed, invalid, unable, not found and the like, in any
 * case; an `error` or `errors` that holds anything; a result code that is a failure. The keys are read in any case and
 * with any separator.
 */
function flagsFailure(o: Record<string, unknown>, depth = 0): boolean {
  for (const [rawKey, v] of Object.entries(o)) {
    const key = keyForm(rawKey);
    if (YES_NO_KEYS.has(key) && saysNo(v)) return true;
    if (SAYING_KEYS.has(key) && saysFailure(v)) return true;
    if (ERROR_KEYS.has(key) && holdsSomething(v)) return true;
    if (key === 'status') {
      const n = statusOf(v);
      if (n !== null && n >= 400) return true;
    }
    if (
      RESULT_CODE_KEYS.has(key) &&
      v !== null &&
      v !== undefined &&
      v !== ''
    ) {
      const n = codeOf(v);
      if (n !== null) {
        if (failedCode(n)) return true;
      } else if (
        typeof v !== 'string' ||
        !SUCCESS_WORDS.has(v.trim().toLowerCase())
      ) {
        return true;
      }
    }
    if (CODE_KEYS.has(key)) {
      const n = codeOf(v);
      if (n !== null && failedCode(n)) return true;
    }
    if (depth < FLAG_DEPTH) {
      if (isRecord(v) && flagsFailure(v, depth + 1)) return true;
      if (
        Array.isArray(v) &&
        v
          .slice(0, FLAG_LIST)
          .some((x) => isRecord(x) && flagsFailure(x, depth + 1))
      )
        return true;
    }
  }
  return false;
}

export function readMeterAnswer(body: unknown): MeterReading {
  if (!isRecord(body)) return { kind: 'unreadable' };
  const { messages } = readFintavaMessages(body);
  const said = messages.join(' | ');
  if (SERVICE_OFF.test(said)) return { kind: 'service_unavailable' };
  if (NO_SUCH_METER.test(said)) return { kind: 'not_found' };
  const status = statusOf(body.status);
  if (status !== null && status >= 400) {
    const { kind, messages: texts } = classifyFintavaFailure({
      httpStatus: status,
      body,
      call: 'read',
    });
    return { kind: 'failed', failure: kind, status, messages: texts };
  }
  if (!('data' in body)) return { kind: 'unreadable' };
  const data = body.data;
  if (data === null) return { kind: 'not_found' };
  if (!isRecord(data)) return { kind: 'unreadable' };
  if (Object.keys(data).length === 0) return { kind: 'not_found' };
  // A found meter needs no failure flag anywhere in the body, and a name a person could have (R3-1, R3-2).
  if (flagsFailure(body)) return { kind: 'unreadable' };
  const name = firstText(data, NAME_KEYS);
  if (name === null || isNotAnOwner(name)) return { kind: 'unreadable' };
  return { kind: 'owner', name, address: firstText(data, ADDRESS_KEYS), data };
}
