import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The unsubscribe link in every email (EMAIL-01).
 *
 * A signed token that carries the address, so nothing is stored per link and a
 * link works for as long as the signing secret does (an unsubscribe link must
 * not expire). The signing key is derived from ADMIN_JWT_SECRET with a label,
 * so this signature can never be replayed as an admin token and no new secret
 * has to be deployed.
 */
const LABEL = 'wawu:email-unsubscribe:v1';

function key(secret: string | undefined): Buffer {
  if (!secret || secret.length < 32) {
    throw new Error(
      'ADMIN_JWT_SECRET is unset or shorter than 32 characters; unsubscribe links cannot be signed.',
    );
  }
  return createHmac('sha256', secret).update(LABEL).digest();
}

function mac(payload: string, secret: string | undefined): string {
  return createHmac('sha256', key(secret)).update(payload).digest('base64url');
}

export function signUnsubscribeToken(
  email: string,
  secret: string | undefined,
): string {
  const payload = Buffer.from(email.trim().toLowerCase()).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

/** The address when the token is genuine; otherwise null. */
export function verifyUnsubscribeToken(
  token: string,
  secret: string | undefined,
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
  const email = Buffer.from(payload, 'base64url').toString('utf8');
  return email.includes('@') ? email : null;
}

export function unsubscribeUrl(
  base: string,
  email: string,
  secret: string | undefined,
): string {
  return `${base.replace(/\/+$/, '')}/api/hub/email/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(email, secret))}`;
}
