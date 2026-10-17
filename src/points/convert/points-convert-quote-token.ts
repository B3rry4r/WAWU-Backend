import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { FeeSettings } from '../../money/fees/fee-config';

/**
 * What a points-to-cash quote token carries: the person and every figure the
 * quote shows, so a conversion can be refused if any of them has changed since
 * (TIER-06 round 2, the cash-out pays the quote it was given or nothing).
 * Short keys: it travels in the convert request's body.
 */
export interface ConvertQuoteClaims {
  v: 1;
  /** wawuUserId the quote was given to. */
  u: string;
  /** The points quoted. */
  p: number;
  /** Kobo paid for 1,000 points. */
  r: number;
  /** The cash for `p` points, in kobo. */
  c: number;
  /** The fewest points one conversion takes. */
  m: number;
  /** The most points one conversion takes, or null with no cap. */
  x: number | null;
  /** What the person pays to convert, in kobo. */
  f: number;
  /** expiresAt, in epoch milliseconds. */
  e: number;
}

const TOKEN_CONTEXT = 'wawu-points-convert-quote.v1.';

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Signs and reads the quote tokens of `GET /points/convert/quote`, under the
 * same key as the fee quotes (FEE_QUOTE_KEY) and a context string of its own,
 * so a token made for one use is never accepted for the other. Stateless: a
 * restart without a configured key only makes open quotes stale (one re-quote).
 */
@Injectable()
export class PointsConvertQuoteToken {
  constructor(private readonly fees: FeeSettings) {}

  /** How long a quote is honoured, in seconds (the fee quotes' own setting). */
  get seconds(): number {
    return this.fees.quoteSeconds;
  }

  sign(claims: ConvertQuoteClaims): string {
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    return `${payload}.${b64url(this.mac(payload))}`;
  }

  /** The claims of a token this server signed, or null for anything else. */
  read(token: unknown): ConvertQuoteClaims | null {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = this.mac(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return null;
    try {
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as ConvertQuoteClaims;
      return claims && claims.v === 1 ? claims : null;
    } catch {
      return null;
    }
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.fees.quoteKey())
      .update(TOKEN_CONTEXT + payload)
      .digest();
  }
}
