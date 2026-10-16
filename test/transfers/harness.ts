import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { Response } from 'supertest';
import type { MoneyErrorReason } from '../../src/money/dto/money-error.dto';

/**
 * Pieces the WALLET-07 send specs share (the Fintava one and the one with
 * Nuvion stood in): a token the stand-in WAWU ID's key signed, a logger that
 * keeps its lines, the answer envelope, and waiting on a condition.
 */

export const PIN = '4826';
export const WRONG_PIN = '1397';

export function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `send-${sub}@test.wawu.dev`,
      phone: '+2348000009907',
      firstName: 'Send',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

export class QuietLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

export type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};
export const body = <T>(res: Response) => res.body as Envelope<T>;

/** Polls until `ok` answers true. The cap only ends a hang; it is not what the test waits for. */
export async function until(ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2_400; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('until: the condition never held');
}

/** Resolves once `n` callers have arrived, for all of them. */
export function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((r) => (open = r));
  return () => {
    arrived += 1;
    if (arrived >= n) open();
    return all;
  };
}

/**
 * What no answer of a send route may carry: a phone number, in any of the
 * forms a person writes one (`+234...`, `234...`, `080...`), WALLET-07 lead
 * ruling 3.
 */
export const PHONE_SHAPE = /(?:\+?234|\b0)[789][01]\d{8}\b/;
