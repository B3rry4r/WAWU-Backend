// Shared helpers for the live specs (task INBOX-02): a real mock WAWU ID,
// throwaway people, and a socket client that records everything it is sent.
import { readFileSync } from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import type { Response } from 'supertest';
import { WebSocket } from 'ws';
import { LIVE_LIMITS } from '../live-limits';
import type { LiveEvent, LiveReadyFrame } from '../live-event.type';

export const data = <T>(res: Response) => (res.body as { data: T }).data;

export const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
export const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;
export const MOCK_DIR = path.join(__dirname, '../../../mock-wawu-id');

export async function waitForHealth(
  url: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export interface Person {
  sub: string;
  token: string;
  fullName: string;
}

let nonceSeq = 0;
export async function registerPerson(label: string): Promise<Person> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const fullName = `Live Spec ${label}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName,
      email: `live-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken, fullName };
}

/**
 * A token for the same person that runs out after `seconds`, signed with the
 * mock's own key (the one its JWKS publishes), so the Hub verifies it for real.
 */
export function shortLivedToken(person: Person, seconds: number): string {
  const decoded = jwt.decode(person.token, { complete: true });
  if (!decoded || typeof decoded.payload === 'string') throw new Error('token');
  const claims = { ...decoded.payload } as Record<string, unknown>;
  delete claims.iat;
  delete claims.exp;
  return jwt.sign(claims, readFileSync(path.join(MOCK_DIR, 'private.pem')), {
    algorithm: 'RS256',
    keyid: decoded.header.kid,
    expiresIn: seconds,
  });
}

/** One socket, recording everything it is sent. */
export class Client {
  readonly frames: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | undefined;
  ready: LiveReadyFrame | undefined;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const frame = JSON.parse((raw as Buffer).toString('utf8')) as Record<
        string,
        unknown
      >;
      this.frames.push(frame);
      if (frame.type === 'ready')
        this.ready = frame as unknown as LiveReadyFrame;
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    ws.on('error', () => undefined);
  }

  /** Opens a socket and signs in by header or by first frame; resolves once `ready`. */
  static async open(
    port: number,
    token: string | null,
    how: 'header' | 'frame' = 'header',
  ): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_LIMITS.path}`, {
      headers:
        token && how === 'header' ? { Authorization: `Bearer ${token}` } : {},
    });
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade refused: ${res.statusCode}`)),
      );
    });
    if (token && how === 'frame')
      ws.send(JSON.stringify({ type: 'auth', token }));
    if (token) {
      await client.until(() => client.ready !== undefined || !!client.closed);
      if (!client.ready) throw new Error(`not ready: ${client.closed?.code}`);
    }
    return client;
  }

  /** Rejects if the socket is refused at the upgrade. */
  static refused(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_LIMITS.path}`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('was accepted')));
      ws.on('error', () => undefined);
    });
  }

  events(): LiveEvent[] {
    return this.frames.filter(
      (f) => f.type !== 'ready' && f.type !== 'pong',
    ) as unknown as LiveEvent[];
  }

  async until(check: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** The first event matching `pred`, waiting up to `ms`. */
  async event<T extends LiveEvent>(
    pred: (e: LiveEvent) => boolean,
    ms = 2000,
  ): Promise<T> {
    await this.until(() => this.events().some(pred), ms);
    return this.events().find(pred) as T;
  }

  async closedWith(ms = 3000): Promise<{ code: number; reason: string }> {
    await this.until(() => this.closed !== undefined, ms);
    return this.closed!;
  }

  close(): void {
    this.ws.close();
  }
}

export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
