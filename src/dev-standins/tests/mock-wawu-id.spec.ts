import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

/**
 * The local WAWU ID stand-in (mock-wawu-id/server.js), SWEEP-APP-4 rows 135 and 154. It runs on a port of the
 * sweep's own (7880-7887), no database and nothing real.
 */
const PORT = 7881;
const DIR = path.join(__dirname, '../../../mock-wawu-id');
const BASE = `http://127.0.0.1:${PORT}`;
let first: ChildProcess | null = null;

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`)).ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  first = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, MOCK_WAWU_ID_PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100 && !(await healthy()); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!(await healthy()))
    throw new Error('mock-wawu-id did not become healthy in time');
}, 20_000);

afterAll(() => {
  first?.kill();
});

describe('mock-wawu-id', () => {
  it('answers a token pair as the real WAWU ID does, under data, and keeps the flat fields the Hub specs read (row 154)', async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'user@test.wawu.dev',
        password: 'whatever',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
      data?: { accessToken?: string; refreshToken?: string };
    };
    expect(typeof body.data?.accessToken).toBe('string');
    expect(typeof body.data?.refreshToken).toBe('string');
    expect(body.accessToken).toBe(body.data?.accessToken);
    expect(body.refreshToken).toBe(body.data?.refreshToken);
  });

  it('exits with a failure and says so when its port is taken, instead of logging "listening" and exiting 0 (row 135)', () => {
    const second = spawnSync('node', ['server.js'], {
      cwd: DIR,
      env: { ...process.env, MOCK_WAWU_ID_PORT: String(PORT) },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(second.status).toBe(1);
    expect(`${second.stdout}${second.stderr}`).toContain('could not listen');
    expect(`${second.stdout}${second.stderr}`).not.toContain('listening on');
  });
});
