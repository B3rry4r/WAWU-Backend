import { createServer, type Server } from 'node:http';
import {
  createServer as createNetServer,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  FintavaStallServer,
  type StallMode,
} from '../../../../test/fintava/fintava-stall-server';
import { WawuIdClient } from '../wawu-id.client';
import {
  WAWU_ID_TIMEOUT_MS,
  WawuIdTimeoutException,
  wawuIdTimeoutMs,
} from '../wawu-id-exchange';

/**
 * FIX-10: every call WawuIdClient makes ends inside its bound, headers AND
 * body, and frees its socket, when WAWU ID stalls; and answers exactly as
 * before when it does not.
 *
 * The stalled cases run against the raw TCP stand-in FIX-01 built (silent: no
 * headers at all; stall: headers and the start of a body, then nothing;
 * drip: a body that never ends), with garbage collection forced once the
 * headers are out, because a timer nothing holds is what FIX-01 found.
 */

const BOUND_MS = 300;
/** How late past the bound a call may end on a loaded machine. */
const MARGIN_MS = 700;

jest.setTimeout(30_000);

function forcedGc(): () => void {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}
const gc = forcedGc();

const stalled = new FintavaStallServer();
let healthy: Server;
let healthyUrl = '';
let healthyHits: string[] = [];
let healthyStatus = 200;

beforeAll(async () => {
  Logger.overrideLogger(false);
  await stalled.start();
  healthy = createServer((req, res) => {
    healthyHits.push(`${req.method} ${req.url}`);
    res.writeHead(healthyStatus, { 'content-type': 'application/json' });
    if (healthyStatus !== 200) {
      res.end(JSON.stringify({ message: 'no' }));
    } else if (req.url?.endsWith('/lookup')) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'u1',
              firstName: 'Ada',
              lastName: 'Obi',
              verificationTier: 'creator',
            },
            { id: 'u2' },
            { firstName: 'no id' },
          ],
        }),
      );
    } else {
      res.end('{}');
    }
  });
  await new Promise<void>((r) => healthy.listen(0, '127.0.0.1', () => r()));
  healthyUrl = `http://127.0.0.1:${(healthy.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await stalled.stop();
  await new Promise<void>((r) => healthy.close(() => r()));
});
beforeEach(() => {
  healthyHits = [];
  healthyStatus = 200;
});

function client(baseUrl: string, extra: Record<string, string> = {}) {
  return new WawuIdClient(
    new ConfigService({
      WAWU_ID_BASE_URL: baseUrl,
      WAWU_ID_INTERNAL_SERVICE_KEY: 'timeout-spec-key',
      WAWU_ID_READ_TIMEOUT_MS: String(BOUND_MS),
      WAWU_ID_WRITE_TIMEOUT_MS: String(BOUND_MS),
      ...extra,
    }),
  );
}

const calls: Array<{
  name: string;
  run: (c: WawuIdClient) => Promise<unknown>;
  message: string;
}> = [
  {
    name: 'setVerification',
    run: (c) =>
      c.setVerification('u1', 'creator', {
        verifiedAt: new Date(),
        verifiedUntil: null,
      }),
    message:
      'Your verification could not be saved. Your payment is safe, try again in a moment.',
  },
  {
    name: 'updateName',
    run: (c) => c.updateName('u1', { firstName: 'Ada', lastName: 'Obi' }),
    message: 'Your name could not be saved. Try again in a moment.',
  },
  {
    name: 'elevateVerificationTier',
    run: (c) => c.elevateVerificationTier('u1', 'certified_professional'),
    message: 'WAWU ID did not answer in time. Try again in a moment.',
  },
];

const openNow = () => stalled.opened - stalled.closed;

/**
 * Waits (at most 2 s) until no more than `max` sockets are open. After an
 * abort undici opens one idle connection of its own that carries no request,
 * so a call that freed its socket leaves at most one more open than before.
 */
async function openAtMost(max: number): Promise<number> {
  const until = Date.now() + 2_000;
  while (openNow() > max && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return openNow();
}

/**
 * Waits until every socket the server saw open has closed. After an abort
 * undici opens one idle connection of its own, which carries no request and
 * goes when its 4 s keep-alive ends, so this is the baseline: nothing is
 * left open once that has passed.
 */
async function backToBaseline(): Promise<void> {
  const until = Date.now() + 9_000;
  while (stalled.closed < stalled.opened && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Runs `p` and reports how long it took and the worst event-loop delay seen
 * meanwhile. On a loaded machine the loop itself runs late, and that lag is
 * added to the margin (FIX-01 learned this on its stall spec); a call that
 * never ends is still caught, since the bug this spec holds ended at
 * undici's 300 s.
 */
async function timed<T>(
  p: Promise<T>,
): Promise<{ ms: number; out: unknown; lagMs: number }> {
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const started = Date.now();
  const out = await p.then(
    (v) => ({ ok: v }),
    (e: unknown) => ({ err: e }),
  );
  const ms = Date.now() - started;
  lag.disable();
  return { ms, out, lagMs: Math.ceil(lag.max / 1e6) };
}

const MODES: StallMode[] = ['silent', 'stall-200', 'drip-200'];

describe('a stalled WAWU ID', () => {
  describe.each(MODES)('answering %s', (mode) => {
    async function whileCollecting<T>(p: () => Promise<T>): Promise<T> {
      const timer = setInterval(gc, 20);
      try {
        return await p();
      } finally {
        clearInterval(timer);
      }
    }

    it('answers a lookup as an empty map inside the bound and frees the socket', async () => {
      const c = client(stalled.baseUrl(mode));
      const openBefore = openNow();
      const { ms, out, lagMs } = await whileCollecting(() =>
        timed(c.lookupPublicIdentities(['u1', 'u2'])),
      );
      expect(out).toEqual({ ok: new Map() });
      expect(ms).toBeGreaterThanOrEqual(BOUND_MS - 50);
      expect(ms).toBeLessThan(BOUND_MS + MARGIN_MS + lagMs);
      expect(await openAtMost(openBefore + 1)).toBeLessThanOrEqual(
        openBefore + 1,
      );
    });

    it.each(calls)(
      '$name ends inside the bound with a 502 timeout and frees the socket',
      async ({ run, message }) => {
        const c = client(stalled.baseUrl(mode));
        const openBefore = openNow();
        const { ms, out, lagMs } = await whileCollecting(() => timed(run(c)));
        const err = (out as { err?: unknown }).err;
        expect(err).toBeInstanceOf(WawuIdTimeoutException);
        expect(err).toBeInstanceOf(BadGatewayException);
        expect((err as WawuIdTimeoutException).getStatus()).toBe(502);
        expect((err as WawuIdTimeoutException).message).toBe(message);
        expect((err as WawuIdTimeoutException).boundMs).toBe(BOUND_MS);
        expect(ms).toBeGreaterThanOrEqual(BOUND_MS - 50);
        expect(ms).toBeLessThan(BOUND_MS + MARGIN_MS + lagMs);
        expect(await openAtMost(openBefore + 1)).toBeLessThanOrEqual(
          openBefore + 1,
        );
      },
    );
  });

  it('pays the bound once for a lookup of many chunks, and tries no chunk after the stall', async () => {
    let requests = 0;
    const open = new Set<Socket>();
    const raw = createNetServer((socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      socket.on('error', () => undefined);
      socket.on('data', (d: Buffer) => {
        if (d.toString('latin1').startsWith('POST ')) requests += 1;
      });
    });
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(raw.address() as AddressInfo).port}`;
    try {
      const ids = Array.from({ length: 250 }, (_, i) => `user-${i}`);
      const { ms, out, lagMs } = await timed(
        client(url).lookupPublicIdentities(ids),
      );
      expect(out).toEqual({ ok: new Map() });
      expect(ms).toBeLessThan(BOUND_MS + MARGIN_MS + lagMs);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((r) => {
        raw.close(() => r());
        for (const socket of open) socket.destroy();
      });
    }
  });

  it('holds no socket after many stalled requests at once', async () => {
    const openBefore = openNow();
    const c = client(stalled.baseUrl('silent'));
    const { ms, out, lagMs } = await timed(
      Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          c.lookupPublicIdentities([`u${i}`]),
        ),
      ),
    );
    const results = (out as { ok: Map<string, unknown>[] }).ok;
    expect(results).toHaveLength(40);
    expect(results.every((m) => m.size === 0)).toBe(true);
    expect(ms).toBeLessThan(BOUND_MS + MARGIN_MS * 2 + lagMs);
    // 40 requests held 40 sockets; every one is closed, and undici's own
    // idle connections (at most one per abort) are all that is left.
    expect(await openAtMost(openBefore + 40)).toBeLessThanOrEqual(
      openBefore + 40,
    );
    await backToBaseline();
    expect(stalled.closed).toBe(stalled.opened);
  });
});

describe('a healthy WAWU ID', () => {
  it('reads a lookup as it always did', async () => {
    const out = await client(healthyUrl).lookupPublicIdentities([
      'u1',
      'u2',
      'u1',
    ]);
    expect(out).toEqual(
      new Map([
        [
          'u1',
          { firstName: 'Ada', lastName: 'Obi', verificationTier: 'creator' },
        ],
        ['u2', { firstName: null, lastName: null, verificationTier: 'basic' }],
      ]),
    );
    expect(healthyHits).toEqual(['POST /internal/users/lookup']);
  });

  it('chunks a lookup of 250 ids into three requests', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `user-${i}`);
    await client(healthyUrl).lookupPublicIdentities(ids);
    expect(healthyHits).toHaveLength(3);
  });

  it('sends the three writes as it always did', async () => {
    const c = client(healthyUrl);
    await c.setVerification('u1', 'professional', {
      verifiedAt: null,
      verifiedUntil: null,
    });
    await c.elevateVerificationTier('u1', 'certified_professional');
    await c.updateName('u1', { firstName: 'Ada', lastName: 'Obi' });
    expect(healthyHits).toEqual([
      'PATCH /internal/users/u1/verification',
      'PATCH /internal/users/u1/verification-tier',
      'PATCH /internal/users/u1/name',
    ]);
  });

  it('answers a refusal the way it always did', async () => {
    healthyStatus = 500;
    const c = client(healthyUrl);
    expect(await c.lookupPublicIdentities(['u1'])).toEqual(new Map());
    await expect(
      c.setVerification('u1', 'creator', {
        verifiedAt: new Date(),
        verifiedUntil: null,
      }),
    ).rejects.toMatchObject({
      message: calls[0].message,
      status: 502,
    });
    await expect(
      c.updateName('u1', { firstName: 'Ada', lastName: 'Obi' }),
    ).rejects.toMatchObject({ message: calls[1].message, status: 502 });
    await expect(
      c.elevateVerificationTier('u1', 'certified_professional'),
    ).rejects.toThrow(new Error('WAWU ID verification-tier update failed'));
    await expect(
      c.elevateVerificationTier('u1', 'certified_professional'),
    ).rejects.not.toBeInstanceOf(WawuIdTimeoutException);
  });

  it('answers an unreachable WAWU ID as before (a lookup is empty, a write throws what fetch threw)', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((r) => dead.close(() => r()));
    const c = client(url);
    expect(await c.lookupPublicIdentities(['u1'])).toEqual(new Map());
    const err = await c
      .updateName('u1', { firstName: 'A', lastName: 'B' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WawuIdTimeoutException);
  });
});

describe('the bound', () => {
  const cfg = (v: Record<string, unknown>) => new ConfigService(v);

  it('has one default per kind of call', () => {
    expect(WAWU_ID_TIMEOUT_MS).toEqual({ read: 3_000, write: 8_000 });
    expect(wawuIdTimeoutMs(cfg({}), 'read')).toBe(3_000);
    expect(wawuIdTimeoutMs(cfg({}), 'write')).toBe(8_000);
  });

  it('ignores a setting under 100 ms, which no healthy answer could meet, and takes 100 itself (SWEEP-APP-1 FIX-10 L3)', () => {
    for (const slip of ['1', '99', '0x10', '16']) {
      expect(
        wawuIdTimeoutMs(cfg({ WAWU_ID_READ_TIMEOUT_MS: slip }), 'read'),
      ).toBe(3_000);
      expect(
        wawuIdTimeoutMs(cfg({ WAWU_ID_WRITE_TIMEOUT_MS: slip }), 'write'),
      ).toBe(8_000);
    }
    expect(
      wawuIdTimeoutMs(cfg({ WAWU_ID_READ_TIMEOUT_MS: '100' }), 'read'),
    ).toBe(100);
  });

  it('takes a whole number of milliseconds from config and ignores anything else', () => {
    expect(
      wawuIdTimeoutMs(cfg({ WAWU_ID_READ_TIMEOUT_MS: '1500' }), 'read'),
    ).toBe(1_500);
    expect(
      wawuIdTimeoutMs(cfg({ WAWU_ID_WRITE_TIMEOUT_MS: 2500 }), 'write'),
    ).toBe(2_500);
    for (const bad of ['', '0', '-5', '1.5', 'abc', '999999999', undefined]) {
      expect(
        wawuIdTimeoutMs(cfg({ WAWU_ID_READ_TIMEOUT_MS: bad }), 'read'),
      ).toBe(3_000);
    }
  });
});
