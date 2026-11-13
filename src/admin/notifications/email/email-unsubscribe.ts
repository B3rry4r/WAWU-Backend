import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailBrand } from './email-config';

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

/**
 * EMAIL-03: a Voices token is `payload.signature.voices` and its signature
 * covers the brand as well, so a Who Made This token cannot be turned into a
 * Voices one (or back) by adding or dropping the last part. A token with two
 * parts is the old shape and always means Who Made This.
 */
const VOICES_PART = 'voices';

export function signUnsubscribeToken(
  email: string,
  secret: string | undefined,
  brand: EmailBrand = 'wmt',
): string {
  const payload = Buffer.from(email.trim().toLowerCase()).toString('base64url');
  if (brand === 'voices') {
    return `${payload}.${mac(`${VOICES_PART}.${payload}`, secret)}.${VOICES_PART}`;
  }
  return `${payload}.${mac(payload, secret)}`;
}

/** The address and the brand when the token is genuine; otherwise null. */
export function readUnsubscribeToken(
  token: string,
  secret: string | undefined,
): { email: string; brand: EmailBrand } | null {
  const [payload, signature, third, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  let brand: EmailBrand;
  if (third === undefined) brand = 'wmt';
  else if (third === VOICES_PART) brand = 'voices';
  else return null;
  let expected: string;
  try {
    expected = mac(
      brand === 'voices' ? `${VOICES_PART}.${payload}` : payload,
      secret,
    );
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const email = Buffer.from(payload, 'base64url').toString('utf8');
  return email.includes('@') ? { email, brand } : null;
}

/** The address when the token is genuine; otherwise null. */
export function verifyUnsubscribeToken(
  token: string,
  secret: string | undefined,
): string | null {
  return readUnsubscribeToken(token, secret)?.email ?? null;
}

export function unsubscribeUrl(
  base: string,
  email: string,
  secret: string | undefined,
  brand: EmailBrand = 'wmt',
): string {
  return `${base.replace(/\/+$/, '')}/api/hub/email/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(email, secret, brand))}`;
}
