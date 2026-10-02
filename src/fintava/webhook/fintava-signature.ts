import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Fintava's webhook signature (task MONEY-07): HMAC-SHA512 of the RAW
 * request body, keyed with the dashboard's webhook secret, as lower-case
 * hex, in the `x-fintava-signature` header (mobile repo
 * `docs/fintava/reference/verifying-events.md`). No timestamp is signed, so
 * a captured delivery verifies forever; the event store's unique key is
 * the replay protection.
 */
export const FINTAVA_SIGNATURE_HEADER = 'x-fintava-signature';

/** 512 bits as hex. */
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;

/** The signature Fintava sends for these exact bytes. */
export function signFintavaBody(secret: string, rawBody: Buffer): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

/**
 * True when `provided` is the signature of `rawBody` under `secret`. The
 * comparison is constant time over the 64 decoded bytes; anything that is
 * not 128 hex digits is refused before it. Hex case is ignored (the digest
 * is the same bytes either way).
 */
export function fintavaSignatureMatches(
  secret: string,
  rawBody: Buffer,
  provided: string,
): boolean {
  const given = provided.trim().toLowerCase();
  if (!SIGNATURE_HEX.test(given)) return false;
  const expected = Buffer.from(signFintavaBody(secret, rawBody), 'hex');
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
}
