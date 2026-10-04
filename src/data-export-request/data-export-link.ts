import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The link in the export email (SETTINGS-04).
 *
 * A signed token, not a stored one: it carries the request id and an expiry,
 * and an HMAC proves this server issued it. Nothing about it is guessable and
 * nothing needs a new column. It is revoked the way the export itself is: the
 * request row it names is deleted with the account (account-purge), and a
 * token for a row that is gone is refused.
 *
 * The signing key is derived from ADMIN_JWT_SECRET with a label, so this
 * signature can never be replayed as an admin token and no new secret has to
 * be deployed. Default (agent), owner may override.
 *
 * Not single-use on purpose: mail scanners open links before the person
 * does, and a one-time link would be spent by the scanner. The expiry is the
 * limit instead.
 */

/**
 * PROVISIONAL(EXPORT-LINK-HOURS, owner=DEV, why=no ruling names how long an export link lives; 72 hours is a security default, not a legal line)
 */
export const EXPORT_LINK_HOURS = 72;

const LABEL = 'wawu:data-export-link:v1';

function key(secret: string | undefined): Buffer {
  if (!secret || secret.length < 32) {
    throw new Error(
      'ADMIN_JWT_SECRET is unset or shorter than 32 characters; export links cannot be signed.',
    );
  }
  return createHmac('sha256', secret).update(LABEL).digest();
}

function mac(payload: string, secret: string | undefined): string {
  return createHmac('sha256', key(secret)).update(payload).digest('base64url');
}

export function signExportLink(
  requestId: string,
  expiresAt: Date,
  secret: string | undefined,
): string {
  const payload = Buffer.from(
    JSON.stringify({ r: requestId, e: Math.floor(expiresAt.getTime() / 1000) }),
  ).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

/** The request id when the token is genuine and unexpired; otherwise null. */
export function verifyExportLink(
  token: string,
  secret: string | undefined,
  now: Date = new Date(),
): string | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  let expected: string;
  try {
    expected = mac(payload, secret);
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { r?: unknown; e?: unknown };
    if (typeof parsed.r !== 'string' || typeof parsed.e !== 'number')
      return null;
    if (parsed.e * 1000 <= now.getTime()) return null;
    return parsed.r;
  } catch {
    return null;
  }
}
