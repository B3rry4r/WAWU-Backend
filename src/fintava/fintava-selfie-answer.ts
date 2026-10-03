/**
 * Reading a selfie match's answer (task KYC-02), by allowlist.
 *
 * Fintava documents no verdict field for `POST /compliance/verify/bvn/selfie`:
 * the reference page's 200 example is `{}` with an empty schema, a failed
 * match is a 400 (mobile repo `docs/fintava/sandbox/05-bvn-selfie.md`), and
 * the success body has never been seen (`docs/fintava/naira-api.md`,
 * question 6). So the answer is not searched for signs of a "no" (verifier
 * rounds 1 and 2 found "no"s under names, depths and encodings a search
 * missed). It is compared with the exact shapes below, and anything else is
 * unreadable: no verdict, never a match.
 *
 * Readable answers, and only these:
 * - HTTP 200 exactly (not 201, 202 or any other 2xx), a JSON content type
 *   (`application/json`, optionally `; charset=utf-8`), and a body that is
 *   JSON with no key named twice at any level (JSON.parse would keep the
 *   last one silently).
 * - A verdict: Fintava's success envelope as every compliance check answers
 *   it in the sandbox (`sandbox/04-`, `06-`: `{ data, status: 200, message:
 *   "successful" }`; `message` may be absent), whose `data` holds exactly one
 *   key, one of SELFIE_VERDICT_KEYS, set to a boolean. `true` is a match;
 *   `false` is an explicit "no".
 * - Fintava's documented failure envelope (`{ status: 400, timestamp,
 *   message, path }`, `sandbox/05-`) with no `data`: an explicit "no".
 *
 * Every key at every level must be one named here. A score, an echoed BVN or
 * photo, a second verdict, a status word, an error field, anything nested
 * deeper: the answer is unreadable. Until Fintava shows its real success
 * body (and the verdict names are narrowed to its field), no selfie passes;
 * that is the expected state (mobile repo BACKEND_GAPS G-25).
 */

/** The answer is not one of the shapes above. The client calls it `bad_response`. */
export class SelfieAnswerUnreadable extends Error {}

/**
 * Candidate names for the one verdict field. None is documented; the list
 * is narrowed to Fintava's field when its success body is seen.
 */
export const SELFIE_VERDICT_KEYS: readonly string[] = [
  'match',
  'matched',
  'is_match',
  'isMatch',
  'face_match',
  'faceMatch',
  'selfie_match',
  'selfieMatch',
];

/** The success envelope's keys (`sandbox/04-`, `06-`, `22-`). */
const SUCCESS_KEYS: readonly string[] = ['data', 'status', 'message'];
const SUCCESS_STATUS = 200;
const SUCCESS_MESSAGE = 'successful';
/** The failure envelope's keys (`sandbox/05-`, `24-`). */
const FAILURE_KEYS: readonly string[] = [
  'status',
  'timestamp',
  'message',
  'path',
];
const FAILURE_STATUS = 400;
/**
 * The deepest the readable shapes go: the body, then `data` (or the failure
 * envelope's `message` list). Anything deeper is refused while it is read,
 * so a deeply nested answer costs nothing.
 */
const MAX_DEPTH = 2;

export interface SelfieAnswer {
  /** The HTTP status. */
  status: number;
  /** The `content-type` header, or null when there is none. */
  contentType: string | null;
  /** The body as text, exactly as received. */
  text: string;
}

/** Reads the answer: a verdict, or SelfieAnswerUnreadable. */
export function readSelfieAnswer(answer: SelfieAnswer): { matched: boolean } {
  if (answer.status !== 200) {
    throw new SelfieAnswerUnreadable(`HTTP ${answer.status} is not 200`);
  }
  if (!isJsonContentType(answer.contentType)) {
    throw new SelfieAnswerUnreadable('the answer is not labelled JSON');
  }
  const body = parseStrictJson(answer.text, MAX_DEPTH);
  if (!isRecord(body)) {
    throw new SelfieAnswerUnreadable('the body is not an object');
  }
  const keys = Object.keys(body);

  if (keys.includes('data')) {
    if (!keys.every((k) => SUCCESS_KEYS.includes(k))) {
      throw new SelfieAnswerUnreadable('the body has a field not read here');
    }
    if (body.status !== SUCCESS_STATUS) {
      throw new SelfieAnswerUnreadable('the status is not 200');
    }
    if ('message' in body && body.message !== SUCCESS_MESSAGE) {
      throw new SelfieAnswerUnreadable('the message is not "successful"');
    }
    const data = body.data;
    if (!isRecord(data)) {
      throw new SelfieAnswerUnreadable('data is not an object');
    }
    const inData = Object.keys(data);
    if (inData.length !== 1 || !SELFIE_VERDICT_KEYS.includes(inData[0])) {
      throw new SelfieAnswerUnreadable('data is not one verdict field');
    }
    const verdict = data[inData[0]];
    if (typeof verdict !== 'boolean') {
      throw new SelfieAnswerUnreadable('the verdict is not a boolean');
    }
    return { matched: verdict };
  }

  if (
    keys.includes('status') &&
    keys.every((k) => FAILURE_KEYS.includes(k)) &&
    body.status === FAILURE_STATUS &&
    (!('timestamp' in body) || typeof body.timestamp === 'string') &&
    (!('path' in body) || typeof body.path === 'string') &&
    (!('message' in body) || isMessage(body.message))
  ) {
    return { matched: false };
  }
  throw new SelfieAnswerUnreadable('the body is not a documented shape');
}

function isMessage(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    (Array.isArray(v) && v.every((m) => typeof m === 'string'))
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `application/json`, with no parameter or only `charset=utf-8`. */
function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const [type, ...params] = value.split(';').map((p) => p.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => p === 'charset=utf-8' || p === 'charset="utf-8"');
}

// ---------------------------------------------------------------------------
// Strict JSON (RFC 8259): a key named twice in one object is refused, and so
// is anything nested deeper than `maxDepth` containers. Objects are built
// without a prototype, so `__proto__` and `constructor` are ordinary keys
// (and, not being on any allowlist, make the answer unreadable).
// ---------------------------------------------------------------------------

/** Parses `text` as JSON; throws SelfieAnswerUnreadable on anything else. */
export function parseStrictJson(text: string, maxDepth: number): unknown {
  let i = 0;
  const fail = (why: string): never => {
    throw new SelfieAnswerUnreadable(`the body is not readable JSON: ${why}`);
  };
  const space = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
  };
  const string = (): string => {
    // text[i] is the opening quote.
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('an unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        return out;
      }
      if (c < 0x20) fail('a control character in a string');
      if (c !== 0x5c) {
        out += text[i];
        i += 1;
        continue;
      }
      const e = text[i + 1];
      i += 2;
      if (e === '"' || e === '\\' || e === '/') out += e;
      else if (e === 'b') out += '\b';
      else if (e === 'f') out += '\f';
      else if (e === 'n') out += '\n';
      else if (e === 'r') out += '\r';
      else if (e === 't') out += '\t';
      else if (e === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else fail('a bad escape');
    }
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth: number): unknown => {
    space();
    const c = text[i];
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) fail('nested deeper than the answer is read');
      i += 1;
      space();
      if (c === '[') {
        const list: unknown[] = [];
        if (text[i] === ']') {
          i += 1;
          return list;
        }
        for (;;) {
          list.push(value(depth + 1));
          space();
          if (text[i] === ',') i += 1;
          else if (text[i] === ']') {
            i += 1;
            return list;
          } else fail('a bad array');
        }
      }
      const o = Object.create(null) as Record<string, unknown>;
      if (text[i] === '}') {
        i += 1;
        return o;
      }
      for (;;) {
        space();
        if (text[i] !== '"') fail('a key that is not a string');
        const key = string();
        if (Object.prototype.hasOwnProperty.call(o, key)) {
          fail('a key named twice');
        }
        space();
        if (text[i] !== ':') fail('a key without a value');
        i += 1;
        o[key] = value(depth + 1);
        space();
        if (text[i] === ',') i += 1;
        else if (text[i] === '}') {
          i += 1;
          return o;
        } else fail('a bad object');
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m || m[0] === '' || m[0] === '-') fail('an unexpected character');
    i += m![0].length;
    const n = Number(m![0]);
    if (!Number.isFinite(n)) fail('a number out of range');
    return n;
  };
  const result = value(0);
  space();
  if (i !== text.length) fail('more after the value');
  return result;
}
