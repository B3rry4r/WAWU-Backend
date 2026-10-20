import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * SWEEP-APP-6, DV2-05 L2: the stack's identity stand-in (`mock-wawu-id/`) answers the sign-up sequence's
 * progress read. The app reads `GET /auth/signup/progress` once per signed-in session, and the mock had no such
 * route, so every walk of the app on the stack logged one console 404. An account the mock made did not come
 * through the mobile sign-up, so the real service (wawu-id `signup-sequence.service.ts`, `view`) would answer
 * it `done`, not in the sequence; a step is then refused with 409 SIGNUP_ALREADY_FINISHED, and no session or
 * a refresh token is a 401 SESSION_INVALID.
 *
 * The mock is started as a child process on a free loopback port. No host but loopback.
 */
const SCRIPT = join(__dirname, '../../../mock-wawu-id/server.js');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe('SWEEP-APP-6: the mock WAWU ID answers the sign-up progress read', () => {
  let child: ChildProcess;
  let base = '';
  let access = '';
  let refresh = '';

  const call = async (method: string, path: string, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: method === 'POST' ? JSON.stringify({ step: 'email' }) : undefined,
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        MOCK_WAWU_ID_PORT: String(port),
        WAWU_ID_INTERNAL_SERVICE_KEY: 'spec-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the mock did not start')),
        10_000,
      );
      child.stdout?.on('data', (b: Buffer) => {
        if (b.toString().includes('listening on')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', () => reject(new Error('the mock exited')));
    });
    const res = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Progress Spec',
        email: 'progress-spec@example.com',
        phone: '+2348012345678',
        country: 'Nigeria',
        password: 'Password123!',
      }),
    });
    const pair = (await res.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    access = pair.accessToken;
    refresh = pair.refreshToken;
  });

  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it('answers an account in no sequence as done', async () => {
    const r = await call('GET', '/auth/signup/progress', access);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      data: {
        step: 'done',
        inSequence: false,
        accountType: null,
        steps: [],
        emailProven: false,
      },
    });
  });

  it('refuses a step of a sign-up that is finished', async () => {
    const r = await call('POST', '/auth/signup/progress', access);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'SIGNUP_ALREADY_FINISHED' });
  });

  it('is a 401 SESSION_INVALID with no token, a bad token or a refresh token', async () => {
    for (const token of [undefined, 'not-a-token', refresh]) {
      const r = await call('GET', '/auth/signup/progress', token);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ code: 'SESSION_INVALID' });
    }
  });
});
