import {
  NUVION_WEBHOOK_EVENTS,
  type NuvionWebhookEventName,
} from '../nuvion.interface';

/**
 * Reading a Nuvion delivery's body (task NUV-01), from Nuvion's docs (the
 * lead's scratchpad `nuvion/docs/webhooks__overview.md`,
 * `webhooks__event-types.md`, `api-reference__webhooks.md`):
 * - a live delivery is `{ "event": "<group>.<name>", "data": {...} }`;
 * - a test delivery (`POST /webhook-tests`) is `{ "event_group",
 *   "event_name" }` with no data: it proves the signature and nothing else.
 * Most events carry their object in `data` directly (`data.id`,
 * `data.entity_id`); `accounts.created` and `account_details.created` wrap
 * it (`data.account`, `data.account_details`).
 */
export interface NuvionDeliveryReading {
  /** Trimmed, lower case; '' when the body named none. */
  event: string;
  status: 'pending' | 'unrecognised' | 'test';
  resourceId: string | null;
  entityId: string | null;
}

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A short id-like text, or null: what we store and index. */
function idText(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) ? v : null;
}

function isKnown(event: string): event is NuvionWebhookEventName {
  return (NUVION_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

export function readNuvionDelivery(body: unknown): NuvionDeliveryReading {
  if (!isRecord(body)) {
    return {
      event: '',
      status: 'unrecognised',
      resourceId: null,
      entityId: null,
    };
  }
  if (
    body.event === undefined &&
    typeof body.event_group === 'string' &&
    typeof body.event_name === 'string'
  ) {
    const event = `${body.event_group}.${body.event_name}`
      .trim()
      .toLowerCase()
      .slice(0, 100);
    return { event, status: 'test', resourceId: null, entityId: null };
  }
  const event =
    typeof body.event === 'string'
      ? body.event.trim().toLowerCase().slice(0, 100)
      : '';
  const data = isRecord(body.data) ? body.data : null;
  // The object the event is about: `data` itself, or the one it wraps.
  const inner =
    data === null
      ? null
      : idText(data.id) !== null
        ? data
        : ([data.account, data.account_details].find(isRecord) ?? null);
  return {
    event,
    status: isKnown(event) && data !== null ? 'pending' : 'unrecognised',
    resourceId: inner ? idText(inner.id) : null,
    entityId:
      (inner ? idText(inner.entity_id) : null) ??
      (data ? idText(data.entity_id) : null),
  };
}

/**
 * A copy of a parsed body with every NUL (`\u0000`) in a key or a string
 * replaced by U+FFFD: Postgres json cannot hold a NUL, and a delivery it
 * refused would be retried and lost. `rawBody` keeps the original bytes.
 */
export function jsonWithoutNulChars(value: unknown): unknown {
  if (typeof value === 'string') return value.split(NUL).join(REPLACEMENT);
  if (Array.isArray(value)) return value.map(jsonWithoutNulChars);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.split(NUL).join(REPLACEMENT),
        jsonWithoutNulChars(v),
      ]),
    );
  }
  return value;
}
