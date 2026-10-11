import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { Response } from 'supertest';
import type { MoneyErrorReason } from '../../src/money/dto/money-error.dto';

/**
 * Small pieces the MONEY-19 specs share (the poll of one payment and the
 * "not enough" answer, on Fintava and on Nuvion): a real RS256 token for the
 * stand-in WAWU ID, a logger that keeps its lines, the one response envelope,
 * and a wait on a condition (never on a number of milliseconds).
 */

/** A token the stand-in WAWU ID's JWKS verifies, for one person. */
export function mintToken(sub: string, tag: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `${tag}-${sub}@test.wawu.dev`,
      phone: '+2348000009917',
      firstName: 'Poll',
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
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};

export const body = <T>(res: Response) => res.body as Envelope<T>;

/** Waits on a condition, never on time: the cap only ends a hang. */
export async function until(
  ok: () => Promise<boolean> | boolean,
  what = 'the condition',
  capMs = 60_000,
): Promise<void> {
  const end = Date.now() + capMs;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until: ${what} never held`);
}
