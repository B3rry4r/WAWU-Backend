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
 *   text, an owner nested somewhere unknown). The Hub says it could not confirm the meter. It never guesses.
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

const SERVICE_OFF =
  /not currently available|service (is )?(currently |temporarily )?unavailable|(currently|temporarily) unavailable/i;
const NO_SUCH_METER = /not found|no such meter|invalid meter|does not exist/i;

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

/** The first of `keys` (in this order) that holds non-blank text in `data`, trimmed. */
function firstText(data: MeterData, keys: readonly string[]): string | null {
  const byKey = new Map<string, string>();
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v.trim() !== '')
      byKey.set(keyForm(k), v.trim());
  }
  for (const k of keys) {
    const v = byKey.get(k);
    if (v !== undefined) return v;
  }
  return null;
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
  const name = firstText(data, NAME_KEYS);
  if (name === null) return { kind: 'unreadable' };
  return { kind: 'owner', name, address: firstText(data, ADDRESS_KEYS), data };
}
