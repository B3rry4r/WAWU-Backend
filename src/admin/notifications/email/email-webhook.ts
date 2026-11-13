import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Resend signs its webhooks with Svix (EMAIL-03). The signed text is
 * `${svix-id}.${svix-timestamp}.${raw body}`, the key is the base64 part of the
 * `whsec_` secret, and the header `svix-signature` holds one or more
 * space-separated `v1,<base64 HMAC-SHA256>` entries (more than one while a
 * secret is being rotated). A timestamp more than five minutes from our clock
 * is refused, so a captured request cannot be replayed later.
 */
export const SVIX_TOLERANCE_MS = 5 * 60 * 1000;

export type SvixCheck = 'ok' | 'bad_signature' | 'bad_timestamp';

export function svixKey(secret: string): Buffer | null {
  const raw = secret.startsWith('whsec_')
    ? secret.slice('whsec_'.length)
    : secret;
  const key = Buffer.from(raw, 'base64');
  return key.length > 0 ? key : null;
}

/** The signature header value Svix would send for these inputs (a spec uses it). */
export function svixSign(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  const key = svixKey(secret);
  if (!key) throw new Error('The webhook secret is not valid.');
  const mac = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest('base64');
  return `v1,${mac}`;
}

export function checkSvix(args: {
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
  rawBody: Buffer;
  nowMs: number;
}): SvixCheck {
  const seconds = /^\d{1,12}$/.test(args.timestamp)
    ? Number(args.timestamp)
    : NaN;
  if (
    !Number.isFinite(seconds) ||
    Math.abs(args.nowMs - seconds * 1000) > SVIX_TOLERANCE_MS
  ) {
    return 'bad_timestamp';
  }
  const key = svixKey(args.secret);
  if (!key) return 'bad_signature';
  const expected = createHmac('sha256', key)
    .update(`${args.id}.${args.timestamp}.`)
    .update(args.rawBody)
    .digest();
  for (const part of args.signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return 'ok';
    }
  }
  return 'bad_signature';
}

/** How strong a delivery result is: a later weaker one never replaces a stronger one. */
export const DELIVERY_RANK = {
  delayed: 1,
  delivered: 2,
  failed: 3,
  bounced: 4,
  complained: 5,
} as const;
export type Delivery = keyof typeof DELIVERY_RANK;

const EVENT_DELIVERY: Record<string, Delivery> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

export interface ParsedEvent {
  type: string;
  providerId: string | null;
  email: string | null;
  at: Date;
  delivery: Delivery | null;
  note: string | null;
  /** A bounce the provider calls permanent: the address is dead. */
  permanentBounce: boolean;
  complaint: boolean;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** Reads what the Hub needs from one Resend event body; tolerant of missing fields. */
export function parseResendEvent(body: unknown, now: Date): ParsedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    type?: unknown;
    created_at?: unknown;
    data?: Record<string, unknown>;
  };
  const type = str(b.type);
  if (!type) return null;
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  const to = Array.isArray(data.to) ? str(data.to[0]) : str(data.to);
  const bounce =
    data.bounce && typeof data.bounce === 'object'
      ? (data.bounce as Record<string, unknown>)
      : {};
  const failed =
    data.failed && typeof data.failed === 'object'
      ? (data.failed as Record<string, unknown>)
      : {};
  const at = b.created_at ? new Date(String(b.created_at)) : now;
  const delivery = EVENT_DELIVERY[type] ?? null;
  const note =
    type === 'email.bounced'
      ? (str(bounce.message) ?? str(bounce.subType) ?? str(bounce.type))
      : type === 'email.failed'
        ? (str(failed.reason) ?? str(data.reason))
        : type === 'email.complained'
          ? 'The person marked this email as spam.'
          : type === 'email.delivery_delayed'
            ? 'The receiving server has not accepted it yet. Delivery is being retried.'
            : null;
  return {
    type: type.slice(0, 80),
    providerId: str(data.email_id),
    email: to ? to.toLowerCase().slice(0, 254) : null,
    at: Number.isNaN(at.getTime()) ? now : at,
    delivery,
    note: note ? note.slice(0, 300) : null,
    permanentBounce:
      type === 'email.bounced' &&
      String(bounce.type ?? '').toLowerCase() === 'permanent',
    complaint: type === 'email.complained',
  };
}
