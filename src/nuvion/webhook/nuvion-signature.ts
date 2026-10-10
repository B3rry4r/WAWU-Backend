import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Nuvion's webhook signature (task NUV-01), exactly as Nuvion documents it
 * (the lead's scratchpad `nuvion/docs/webhooks__overview.md`, "Verifying
 * webhook signatures"): HMAC-SHA256, keyed with the endpoint's secret, over
 * the string `{timestamp}.{payload}` (the `x-nuvion-event-timestamp` header
 * as sent, a dot, then the raw body), as a hex digest in
 * `x-nuvion-event-signature`. The event id comes in `x-nuvion-event-id`.
 */
export const NUVION_EVENT_ID_HEADER = 'x-nuvion-event-id';
export const NUVION_TIMESTAMP_HEADER = 'x-nuvion-event-timestamp';
export const NUVION_SIGNATURE_HEADER = 'x-nuvion-event-signature';

/** 256 bits as hex. */
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
/** An event id we store and repeat: Nuvion's are ULIDs. */
export const NUVION_EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The signature Nuvion sends for this timestamp and these exact bytes. */
export function signNuvionDelivery(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
    .digest('hex');
}

/**
 * True when `provided` is the signature of `{timestamp}.{rawBody}` under
 * `secret`. Constant time over the 32 decoded bytes; anything that is not
 * 64 hex digits is refused before it. Hex case is ignored.
 */
export function nuvionSignatureMatches(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
  provided: string,
): boolean {
  const given = provided.trim().toLowerCase();
  if (!SIGNATURE_HEX.test(given)) return false;
  const expected = Buffer.from(
    signNuvionDelivery(secret, timestamp, rawBody),
    'hex',
  );
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
}

/**
 * The time `x-nuvion-event-timestamp` names, in ms, or null when it is not
 * a time. Nuvion's delivery logs show ISO 8601 (`2026-08-27T18:31:19.719Z`,
 * api-reference__webhooks.md, "List webhook logs"); Unix seconds or
 * milliseconds are read too, since the docs do not fix the format.
 */
export function readNuvionTimestamp(raw: string): number | null {
  const t = raw.trim();
  if (/^\d{10}$/.test(t)) return Number(t) * 1000;
  if (/^\d{13}$/.test(t)) return Number(t);
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(
      t,
    )
  ) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** True when the signed time is within `windowMs` of `now`, either side. */
export function withinNuvionWindow(
  signedAtMs: number,
  now: number,
  windowMs: number,
): boolean {
  return Math.abs(now - signedAtMs) <= windowMs;
}
