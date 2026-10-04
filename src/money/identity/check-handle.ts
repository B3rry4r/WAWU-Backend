import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IdentityHasher } from './identity-config';

/**
 * The check handle (task KYC-03, BACKEND_GAPS G-72 in the mobile repo).
 *
 * The selfie match (KYC-02) and the account opening (MONEY-12) need the BVN
 * (and the NIN) again, because Fintava takes them in full. The server keeps
 * only keyed hashes and the last 4 digits (KYC-01's storage rule), and the
 * app does not keep the numbers after the BVN check's request. So the check
 * that passed answers an opaque handle: the numbers, sealed under a server
 * key, that the app holds in memory and sends back in their place. Nothing
 * new is stored anywhere: the handle lives in the app's memory and in the
 * two requests that carry it.
 *
 * Sealed with AES-256-GCM (authenticated: a changed byte fails to open)
 * under a key derived from IDENTITY_HASH_KEY with HKDF and the label
 * `wawu/kyc-check-handle/v1` (`IdentityHasher.deriveKey`), with a fresh
 * 12-byte nonce per handle and the label as associated data. It carries
 * `{ sub, bvn, nin, checkId, iat, exp }`: whose check it is, the numbers,
 * the BvnCheckAttempt that passed, and its 30 minutes of life. Opening it
 * checks the seal and the shape only; the caller then checks `sub`, `exp`
 * and the passed check (`WalletIdentityService.checkedByHandle`).
 *
 * A handle is never logged, never stored and never echoed: no message,
 * error or log line names it or anything in it.
 */
export const CHECK_HANDLE_LABEL = 'wawu/kyc-check-handle/v1';

/**
 * How long a handle opens, in seconds: long enough for A5 and a selfie or
 * two, short enough that one copied off a phone is soon worthless. Default
 * (lead), owner may override.
 */
export const CHECK_HANDLE_TTL_SECONDS = 30 * 60;

/** The longest handle accepted: a sealed payload is under 300 characters. */
export const CHECK_HANDLE_MAX_LENGTH = 1024;

const VERSION = 'v1.';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ELEVEN_DIGITS = /^[0-9]{11}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Seconds of clock difference between servers allowed on `iat`. */
const CLOCK_SKEW_SECONDS = 60;

/** What a check handle carries. Times are whole seconds since the epoch. */
export type CheckHandleClaims = {
  sub: string;
  bvn: string;
  nin: string;
  checkId: string;
  iat: number;
  exp: number;
};

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function readClaims(json: string): CheckHandleClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'bvn,checkId,exp,iat,nin,sub') return null;
  if (
    typeof v.sub !== 'string' ||
    v.sub.length === 0 ||
    typeof v.bvn !== 'string' ||
    !ELEVEN_DIGITS.test(v.bvn) ||
    typeof v.nin !== 'string' ||
    !ELEVEN_DIGITS.test(v.nin) ||
    typeof v.checkId !== 'string' ||
    !UUID.test(v.checkId) ||
    !Number.isSafeInteger(v.iat) ||
    !Number.isSafeInteger(v.exp)
  ) {
    return null;
  }
  return v as CheckHandleClaims;
}

@Injectable()
export class CheckHandleSealer {
  constructor(private readonly hasher: IdentityHasher) {}

  /** Seals a passed check for `sub`. Throws only when IDENTITY_HASH_KEY is not set (no check can pass then). */
  seal(
    input: { sub: string; bvn: string; nin: string; checkId: string },
    now = new Date(),
  ): string {
    const iat = nowSeconds(now);
    const claims: CheckHandleClaims = {
      sub: input.sub,
      bvn: input.bvn,
      nin: input.nin,
      checkId: input.checkId,
      iat,
      exp: iat + CHECK_HANDLE_TTL_SECONDS,
    };
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(CHECK_HANDLE_LABEL));
    const sealed = Buffer.concat([
      cipher.update(JSON.stringify(claims), 'utf8'),
      cipher.final(),
    ]);
    return (
      VERSION +
      Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64url')
    );
  }

  /**
   * The claims of a handle this server sealed, unexpired at `now`, or null
   * for anything else (malformed, another key, a changed byte, expired, a
   * shape it never seals). One answer for every failure: the caller says
   * "check your BVN again" and never which part failed.
   */
  open(handle: unknown, now = new Date()): CheckHandleClaims | null {
    if (
      typeof handle !== 'string' ||
      handle.length > CHECK_HANDLE_MAX_LENGTH ||
      !handle.startsWith(VERSION) ||
      !this.hasher.configured
    ) {
      return null;
    }
    const body = handle.slice(VERSION.length);
    if (!BASE64URL.test(body)) return null;
    const bytes = Buffer.from(body, 'base64url');
    if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        bytes.subarray(0, NONCE_BYTES),
      );
      decipher.setAAD(Buffer.from(CHECK_HANDLE_LABEL));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      const json = Buffer.concat([
        decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
      const claims = readClaims(json);
      if (!claims) return null;
      const t = nowSeconds(now);
      if (claims.exp <= t || claims.iat > t + CLOCK_SKEW_SECONDS) return null;
      if (claims.exp - claims.iat > CHECK_HANDLE_TTL_SECONDS) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private key(): Buffer {
    return this.hasher.deriveKey(CHECK_HANDLE_LABEL);
  }

  toJSON(): Record<string, never> {
    return {};
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'CheckHandleSealer {}';
  }
}
