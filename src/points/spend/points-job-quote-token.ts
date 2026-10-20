import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { FeeSettings } from '../../money/fees/fee-config';

/**
 * What the quote token of an AI job carries (AITOOLS-01): the person, the
 * tool and the points the quote showed. The job route runs a job only when it
 * costs exactly that now, so a person never pays a price they were not shown
 * (an admin can change a cost between the quote and the tap).
 */
export interface JobQuoteClaims {
  v: 1;
  /** wawuUserId the quote was given to. */
  u: string;
  /** The plan's action id the quote was for. */
  a: string;
  /** The points the quote showed. */
  c: number;
  /** expiresAt, in epoch milliseconds. */
  e: number;
}

const TOKEN_CONTEXT = 'wawu-points-job-quote.v1.';

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Signs and reads the quote tokens of `POST /points/quote`, under the same key
 * as the fee quotes (FEE_QUOTE_KEY) and a context string of its own, so a
 * token made for one use is never accepted for another. Stateless: a restart
 * without a configured key only makes open quotes stale (one re-quote).
 */
@Injectable()
export class PointsJobQuoteToken {
  constructor(private readonly fees: FeeSettings) {}

  /** How long a quote is honoured, in seconds (the fee quotes' own setting). */
  get seconds(): number {
    return this.fees.quoteSeconds;
  }

  /** A token for `costPoints` of `action`, good for `seconds` from `now`. */
  issue(
    wawuUserId: string,
    action: string,
    costPoints: number,
    now: Date = new Date(),
  ): string {
    return this.sign({
      v: 1,
      u: wawuUserId,
      a: action,
      c: costPoints,
      e: now.getTime() + this.seconds * 1000,
    });
  }

  sign(claims: JobQuoteClaims): string {
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    return `${payload}.${b64url(this.mac(payload))}`;
  }

  /** The claims of a token this server signed, or null for anything else. */
  read(token: unknown): JobQuoteClaims | null {
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
      ) as JobQuoteClaims;
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
