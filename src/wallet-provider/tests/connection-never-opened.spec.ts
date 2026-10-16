import { createServer, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { runInNewContext } from 'node:vm';
import { Logger } from '@nestjs/common';
import { fintavaConfig } from '../../../test/fintava/fintava-double';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import { FintavaClient } from '../../fintava/fintava-client';
import { FintavaError } from '../../fintava/fintava-error';
import { toWalletProviderError } from '../../fintava/fintava-wallet-provider';
import { NuvionClient, type NuvionOp } from '../../nuvion/nuvion-client';
import {
  CONNECT_TIMEOUT_CODE,
  CONNECTION_NEVER_OPENED_SYSCALL,
  connectionNeverOpened,
} from '../connection-never-opened';
import { WalletProviderError } from '../wallet-provider-error';

/**
 * MONEY-18 round 2, O1: a request that provably never reached the provider
 * (the connection was refused, the host name did not resolve) is marked
 * `requestNotSent`, so a release or refund can be sent again under the same
 * reference; every other loss is still an unknown outcome that is asked
 * about and never sent again.
 *
 * Round 3, R2-1: the error CODE alone is not proof. Node raises
 * ECONNREFUSED, ENETUNREACH and EHOSTUNREACH on an established connection
 * too (`read EHOSTUNREACH`, after the provider read the whole request), so
 * the SYSCALL decides: `connect` for those three, `getaddrinfo` for the two
 * name codes. Every fixture below carries the syscall a real error carries
 * (the shapes were read from real sockets: the route failing after the write
 * gave `read EHOSTUNREACH` errno -113, `read ENETUNREACH` -101 and
 * `read ECONNREFUSED` -111; `npm run test:netns` (`test/netns/`)
 * produces them again).
 */

/** The error Node raises for a failure in `syscall`, as a real one is shaped. */
const ERRNO: Record<string, number> = {
  ECONNREFUSED: -111,
  ENETUNREACH: -101,
  EHOSTUNREACH: -113,
  ECONNRESET: -104,
  ETIMEDOUT: -110,
  EPIPE: -32,
  ENOTFOUND: -3008,
  EAI_AGAIN: -3001,
};
const socketError = (code: string, syscall: string, extra: object = {}) =>
  Object.assign(new Error(`${syscall} ${code}`), {
    errno: ERRNO[code] ?? -1,
    code,
    syscall,
    ...extra,
  });
/** A code with no syscall at all (how the old fixtures looked). */
const withCode = (code: string, extra: object = {}) =>
  Object.assign(new Error(`connect ${code}`), { code, ...extra });
const fetchFailed = (cause: unknown) =>
  Object.assign(new TypeError('fetch failed'), { cause });

describe('connectionNeverOpened (the shape of a failed fetch)', () => {
  it.each([...CONNECTION_NEVER_OPENED_SYSCALL])(
    '%s from %s (the phase before any request is written) under fetch failed: the request was not sent',
    (code, syscall) => {
      expect(
        connectionNeverOpened(fetchFailed(socketError(code, syscall))),
      ).toBe(true);
    },
  );

  it('undici connect-phase timeout: the request was not sent', () => {
    const timeout = Object.assign(
      new Error(
        'Connect Timeout Error (attempted address: 10.0.0.1:443, timeout: 10000ms)',
      ),
      { name: 'ConnectTimeoutError', code: CONNECT_TIMEOUT_CODE },
    );
    expect(connectionNeverOpened(fetchFailed(timeout))).toBe(true);
  });

  // R2-1: the same codes on a connection that was already made. The provider
  // read the request; the route failed under the open socket.
  it.each([
    ['EHOSTUNREACH', 'read'],
    ['ENETUNREACH', 'read'],
    ['ECONNREFUSED', 'read'],
    ['EHOSTUNREACH', 'write'],
    ['ENETUNREACH', 'write'],
    ['ECONNREFUSED', 'write'],
  ])(
    '%s from %s (an established connection): the request may have been read, not proof',
    (code, syscall) => {
      expect(
        connectionNeverOpened(fetchFailed(socketError(code, syscall))),
      ).toBe(false);
    },
  );

  it('the three errors a route failing after the write really gave, read from real sockets', () => {
    // verbatim from probes/s13.js: name=Error code=EHOSTUNREACH syscall=read
    // errno=-113 message="read EHOSTUNREACH", and the net and port forms.
    for (const [code, errno] of [
      ['EHOSTUNREACH', -113],
      ['ENETUNREACH', -101],
      ['ECONNREFUSED', -111],
    ] as const) {
      const real = Object.assign(new Error(`read ${code}`), {
        errno,
        code,
        syscall: 'read',
      });
      expect(connectionNeverOpened(fetchFailed(real))).toBe(false);
    }
  });

  it('a code with no syscall, or one from the other phase, is not proof', () => {
    for (const code of CONNECTION_NEVER_OPENED_SYSCALL.keys()) {
      expect(connectionNeverOpened(fetchFailed(withCode(code)))).toBe(false);
    }
    expect(
      connectionNeverOpened(
        fetchFailed(socketError('ECONNREFUSED', 'getaddrinfo')),
      ),
    ).toBe(false);
    expect(
      connectionNeverOpened(fetchFailed(socketError('ENOTFOUND', 'connect'))),
    ).toBe(false);
    expect(
      connectionNeverOpened(fetchFailed(socketError('EAI_AGAIN', 'read'))),
    ).toBe(false);
    // A syscall that is not a string says nothing.
    expect(
      connectionNeverOpened(
        fetchFailed(socketError('ECONNREFUSED', 'connect', { syscall: 7 })),
      ),
    ).toBe(false);
  });

  it('the syscall is read where the code is: the socket error under the wrapper, however deep', () => {
    // `FintavaDeadline.headers` / `NuvionDeadline.headers` wrap a rejection
    // that is not an Error of this realm in a new Error with the original as
    // its cause, so there can be two wrappers above the socket's error.
    const refused = socketError('ECONNREFUSED', 'connect');
    const twice = new Error('fetch failed', { cause: fetchFailed(refused) });
    expect(connectionNeverOpened(twice)).toBe(true);
    const established = socketError('ECONNREFUSED', 'read');
    expect(
      connectionNeverOpened(
        new Error('fetch failed', { cause: fetchFailed(established) }),
      ),
    ).toBe(false);
    // A wrapper's own syscall does not stand in for the cause's.
    expect(
      connectionNeverOpened(
        Object.assign(new Error('wrapper'), {
          syscall: 'connect',
          cause: fetchFailed(established),
        }),
      ),
    ).toBe(false);
  });

  it('the refused connection Node reports, read from a real fetch to a port nobody listens on', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((r) => server.close(() => r()));
    const e: unknown = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      body: '{}',
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).not.toBeNull();
    // Where Node really puts it: the cause of `fetch failed`.
    const cause = (e as { cause?: { code?: string; syscall?: string } }).cause;
    expect(cause?.code).toBe('ECONNREFUSED');
    expect(cause?.syscall).toBe('connect');
    expect(connectionNeverOpened(e)).toBe(true);
  });

  it('a port fetch itself refuses to use (undici: bad port), read from a real fetch to port 1', async () => {
    const e: unknown = await fetch('http://127.0.0.1:1/x', {
      method: 'POST',
      body: '{}',
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).not.toBeNull();
    expect(connectionNeverOpened(e)).toBe(true);
    expect(connectionNeverOpened(fetchFailed(new Error('bad port')))).toBe(
      true,
    );
    // Only that exact refusal: a message that merely contains the words, or
    // one that carries a code of its own, is not it.
    expect(connectionNeverOpened(fetchFailed(new Error('bad port 7')))).toBe(
      false,
    );
    expect(
      connectionNeverOpened(
        fetchFailed(Object.assign(new Error('bad port'), { code: 'EPIPE' })),
      ),
    ).toBe(false);
  });

  it('a host name that does not resolve, read from a real fetch', async () => {
    const e: unknown = await fetch('http://no-such-host.invalid/x').then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).not.toBeNull();
    const cause = (e as { cause?: { code?: string; syscall?: string } }).cause;
    expect(cause?.syscall).toBe('getaddrinfo');
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(cause?.code);
    expect(connectionNeverOpened(e)).toBe(true);
  });

  it('an address list that was refused one by one (an AggregateError) is not sent, but not if one of them failed another way', () => {
    const refused = Object.assign(
      new AggregateError([
        socketError('ECONNREFUSED', 'connect'),
        socketError('ECONNREFUSED', 'connect'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionNeverOpened(fetchFailed(refused))).toBe(true);
    const mixed = Object.assign(
      new AggregateError([
        socketError('ECONNREFUSED', 'connect'),
        socketError('ECONNRESET', 'read'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionNeverOpened(fetchFailed(mixed))).toBe(false);
    // One address refused while connecting, another failed on a read: the
    // aggregate's own code does not decide, its leaves do.
    const oneEstablished = Object.assign(
      new AggregateError([
        socketError('ECONNREFUSED', 'connect'),
        socketError('ECONNREFUSED', 'read'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionNeverOpened(fetchFailed(oneEstablished))).toBe(false);
    // Leaves with a code and no syscall are not proof either.
    const bare = Object.assign(
      new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')]),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionNeverOpened(fetchFailed(bare))).toBe(false);
  });

  it.each([
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_ABORTED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ])('%s may have happened after the request was read: not proof', (code) => {
    expect(connectionNeverOpened(fetchFailed(withCode(code)))).toBe(false);
    for (const syscall of ['connect', 'read', 'write']) {
      expect(
        connectionNeverOpened(fetchFailed(socketError(code, syscall))),
      ).toBe(false);
    }
  });

  it('anything that is not a socket error says nothing', () => {
    expect(connectionNeverOpened(new Error('fetch failed'))).toBe(false);
    expect(connectionNeverOpened(fetchFailed(new Error('no code')))).toBe(
      false,
    );
    expect(connectionNeverOpened(null)).toBe(false);
    expect(connectionNeverOpened(undefined)).toBe(false);
    expect(connectionNeverOpened('ECONNREFUSED')).toBe(false);
    expect(connectionNeverOpened({ code: 7 })).toBe(false);
    expect(
      connectionNeverOpened(
        new DOMException('Fintava did not answer in time', 'TimeoutError'),
      ),
    ).toBe(false);
  });

  it('a cause chain that is too deep, or loops, is not read as proof', () => {
    let deep: unknown = socketError('ECONNREFUSED', 'connect');
    for (let i = 0; i < 12; i += 1) deep = new Error('wrap', { cause: deep });
    expect(connectionNeverOpened(deep)).toBe(false);
    // The same socket error one wrapper down is proof, so the depth is what refuses.
    expect(
      connectionNeverOpened(
        new Error('wrap', { cause: socketError('ECONNREFUSED', 'connect') }),
      ),
    ).toBe(true);
    const loop = new Error('loop');
    (loop as { cause?: unknown }).cause = loop;
    expect(connectionNeverOpened(loop)).toBe(false);
  });

  it('an error from another realm (a jest sandbox) is read the same way', () => {
    const make = (syscall: string) =>
      runInNewContext(
        `Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED', syscall: '${syscall}' }) })`,
      ) as unknown;
    const foreign = make('connect');
    expect(foreign instanceof Error).toBe(false);
    expect(connectionNeverOpened(foreign)).toBe(true);
    expect(connectionNeverOpened(make('read'))).toBe(false);
  });
});

describe('the Fintava client marks a request that never reached Fintava', () => {
  let down: string;
  let hangUp: Server;
  let hangUpUrl: string;
  const MONEY = {
    senderAccountNumber: '1102000001',
    receiverAccountNumber: '1102000002',
    amountKobo: 100_000,
    customerReference: 'wawu-rel-o1',
    narration: 'WAWU earning',
  };
  const clientAt = (baseUrl: string) =>
    new FintavaClient(
      fintavaConfig({
        FINTAVA_BASE_URL: baseUrl,
        FINTAVA_API_KEY: 'live_test_o1_0123456789FAKEKEY',
        FINTAVA_TIMEOUT_MS: '5000',
        FINTAVA_MONEY_TIMEOUT_MS: '5000',
        FINTAVA_CHECK_TIMEOUT_MS: '5000',
      }),
    );

  beforeAll(async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    down = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/api/dev`;
    await new Promise<void>((r) => closed.close(() => r()));
    // Reads the request and drops the line: it may have been acted on.
    hangUp = createServer((req) => {
      req.resume();
      req.on('end', () => req.socket.destroy());
    });
    await new Promise<void>((r) => hangUp.listen(0, '127.0.0.1', () => r()));
    hangUpUrl = `http://127.0.0.1:${(hangUp.address() as AddressInfo).port}/api/dev`;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    hangUp.closeAllConnections();
    await new Promise<void>((r) => hangUp.close(() => r()));
  });

  it('a refused connection on a send: requestNotSent, and it is still an outcome_unknown for every caller that does not read the flag', async () => {
    const e: unknown = await clientAt(down)
      .walletToWallet(MONEY)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(e).toBeInstanceOf(FintavaError);
    const err = e as FintavaError;
    expect(err.kind).toBe('outcome_unknown');
    expect(err.recordMayExist).toBe(true);
    expect(err.requestNotSent).toBe(true);
    // Through the seam too.
    const seam = toWalletProviderError(err) as WalletProviderError;
    expect(seam.requestNotSent).toBe(true);
    expect(seam.recordMayExist).toBe(true);
  });

  it('a line dropped after the request was read: not marked, an unknown outcome', async () => {
    const e: unknown = await clientAt(hangUpUrl)
      .walletToWallet(MONEY)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(e).toBeInstanceOf(FintavaError);
    const err = e as FintavaError;
    expect(err.kind).toBe('outcome_unknown');
    expect(err.recordMayExist).toBe(true);
    expect(err.requestNotSent).toBe(false);
  });

  it('a request that was read and never answered (the deadline passes): not marked, an unknown outcome', async () => {
    const silent = createServer((req) => {
      req.resume();
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/api/dev`;
    const quick = new FintavaClient(
      fintavaConfig({
        FINTAVA_BASE_URL: url,
        FINTAVA_API_KEY: 'live_test_o1_0123456789FAKEKEY',
        FINTAVA_TIMEOUT_MS: '300',
        FINTAVA_MONEY_TIMEOUT_MS: '300',
        FINTAVA_CHECK_TIMEOUT_MS: '300',
      }),
    );
    try {
      const e: unknown = await quick.walletToWallet(MONEY).then(
        () => null,
        (err: unknown) => err,
      );
      const err = e as FintavaError;
      expect(err.kind).toBe('outcome_unknown');
      expect(err.messages).toEqual(['timed out']);
      expect(err.requestNotSent).toBe(false);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it('a refusal Fintava sent is never marked', async () => {
    const refusing = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 400, message: ['no'] }));
      });
    });
    await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}/api/dev`;
    try {
      const e: unknown = await clientAt(url)
        .walletToWallet(MONEY)
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect((e as FintavaError).requestNotSent).toBe(false);
    } finally {
      await new Promise<void>((r) => refusing.close(() => r()));
    }
  });
});

describe('the Nuvion client marks a request that never reached Nuvion', () => {
  const WRITE: NuvionOp = { name: 'make thing', call: 'write' };
  const standin = new NuvionStandin();

  afterEach(() => standin.reset());

  it('a refused connection on a write: requestNotSent; a dropped line is not', async () => {
    await standin.start();
    const settings = standin.settings();
    const client = new NuvionClient(
      settings,
      'nv_test_sk_o1standinKEY0123456789abcdef',
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      standin.loseNext();
      const dropped: unknown = await client
        .post(WRITE, '/transfers', {}, { reference: 'nuv-o1-a' })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(dropped).toBeInstanceOf(WalletProviderError);
      expect((dropped as WalletProviderError).kind).toBe('outcome_unknown');
      expect((dropped as WalletProviderError).requestNotSent).toBe(false);

      // The deadline passes with no answer: not marked either.
      standin.slowNext(1_500);
      const slowClient = new NuvionClient(
        standin.settings({ moneyTimeoutMs: 200 }),
        'nv_test_sk_o1standinKEY0123456789abcdef',
      );
      const timedOut: unknown = await slowClient
        .post(WRITE, '/transfers', {}, { reference: 'nuv-o1-t' })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect((timedOut as WalletProviderError).kind).toBe('outcome_unknown');
      expect((timedOut as WalletProviderError).requestNotSent).toBe(false);

      await standin.stop();
      const refused: unknown = await client
        .post(WRITE, '/transfers', {}, { reference: 'nuv-o1-b' })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(refused).toBeInstanceOf(WalletProviderError);
      const err = refused as WalletProviderError;
      expect(err.kind).toBe('outcome_unknown');
      expect(err.recordMayExist).toBe(true);
      expect(err.requestNotSent).toBe(true);
    } finally {
      jest.restoreAllMocks();
      await standin.stop();
    }
  });
});

/**
 * R2-1, the cases that need no privileges: both real clients over real
 * sockets, with the server counting what it read. A request is marked
 * `requestNotSent` only when the server read nothing; whenever it read the
 * whole request the answer is "ask, never resend", however the line ended.
 * (The route failing under an established connection, `read EHOSTUNREACH`,
 * needs a private network namespace, so it is a script and not a jest test:
 * `npm run test:netns`, which fails when it cannot run.)
 */
describe('both clients over real sockets: marked only when nothing was read', () => {
  type Seen = { bytes: number; full: number };
  type Outcome = {
    kind: string;
    recordMayExist: boolean;
    requestNotSent: boolean;
  };
  const servers: Server[] = [];
  const sockets: Array<ReturnType<typeof createTcpServer>> = [];
  const KEY = 'live_test_o1_0123456789FAKEKEY';
  const NKEY = 'nv_test_sk_o1standinKEY0123456789abcdef';
  const WRITE: NuvionOp = { name: 'make thing', call: 'write' };
  const MONEY = {
    senderAccountNumber: '1102000001',
    receiverAccountNumber: '1102000002',
    amountKobo: 100_000,
    customerReference: 'wawu-rel-r3',
    narration: 'WAWU earning',
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    for (const s of sockets) await new Promise<void>((r) => s.close(() => r()));
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  /** A raw TCP server; `onFull` runs once the whole POST has been read. */
  async function raw(
    onFull: (s: Socket) => void,
    onConnect: (s: Socket) => void = () => undefined,
  ): Promise<{ base: string; seen: Seen }> {
    const seen: Seen = { bytes: 0, full: 0 };
    const server = createTcpServer((s) => {
      let buf = Buffer.alloc(0);
      let fired = false;
      onConnect(s);
      s.on('data', (d: Buffer) => {
        seen.bytes += d.length;
        buf = Buffer.concat([buf, d]);
        const he = buf.indexOf('\r\n\r\n');
        if (he < 0 || fired) return;
        const m = /content-length:\s*(\d+)/i.exec(
          buf.subarray(0, he).toString(),
        );
        if (buf.length >= he + 4 + (m ? Number(m[1]) : 0)) {
          fired = true;
          seen.full += 1;
          onFull(s);
        }
      });
      s.on('error', () => undefined);
    });
    sockets.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}/api/dev`, seen };
  }

  async function closedBase(): Promise<string> {
    const s = createTcpServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return `http://127.0.0.1:${port}/api/dev`;
  }

  async function fintava(base: string, ms = 2_000): Promise<Outcome> {
    const c = new FintavaClient(
      fintavaConfig({
        FINTAVA_BASE_URL: base,
        FINTAVA_API_KEY: KEY,
        FINTAVA_TIMEOUT_MS: String(ms),
        FINTAVA_MONEY_TIMEOUT_MS: String(ms),
        FINTAVA_CHECK_TIMEOUT_MS: String(ms),
      }),
    );
    return c.walletToWallet(MONEY).then(
      () => ({ kind: 'ok', recordMayExist: false, requestNotSent: false }),
      (e: unknown) => e as Outcome,
    );
  }
  async function nuvion(base: string, ms = 2_000): Promise<Outcome> {
    const c = new NuvionClient(
      new NuvionStandin().settings({
        baseUrl: base,
        moneyTimeoutMs: ms,
        readTimeoutMs: ms,
        checkTimeoutMs: ms,
      }),
      NKEY,
    );
    return c.post(WRITE, '/transfers', {}, { reference: 'nuv-r3' }).then(
      () => ({ kind: 'ok', recordMayExist: false, requestNotSent: false }),
      (e: unknown) => e as Outcome,
    );
  }
  const clients = [
    ['Fintava', fintava],
    ['Nuvion', nuvion],
  ] as const;

  it.each(clients)(
    '%s: a closed port is marked, and nothing was sent',
    async (_n, via) => {
      const o = await via(await closedBase());
      expect(o.kind).toBe('outcome_unknown');
      expect(o.recordMayExist).toBe(true);
      expect(o.requestNotSent).toBe(true);
    },
  );

  it.each(clients)(
    '%s: the line reset after the whole request was read is not marked',
    async (_n, via) => {
      const { base, seen } = await raw((s) => s.resetAndDestroy());
      const o = await via(base);
      expect(seen.full).toBe(1);
      expect(o.requestNotSent).toBe(false);
      expect(o.recordMayExist).toBe(true);
    },
  );

  it.each(clients)(
    '%s: closed (FIN) after the whole request, no answer, is not marked',
    async (_n, via) => {
      const { base, seen } = await raw((s) => s.end());
      const o = await via(base);
      expect(seen.full).toBe(1);
      expect(o.requestNotSent).toBe(false);
    },
  );

  it.each(clients)(
    '%s: reset the moment it connects (before a byte) is not marked: nothing proves the request was not read',
    async (_n, via) => {
      const { base } = await raw(
        () => undefined,
        (s) => s.resetAndDestroy(),
      );
      const o = await via(base);
      expect(o.requestNotSent).toBe(false);
    },
  );

  it.each(clients)(
    '%s: a 503 after the whole request is not marked',
    async (_n, via) => {
      const { base, seen } = await raw((s) => {
        const body = JSON.stringify({ status: 503, message: ['down'] });
        s.write(
          `HTTP/1.1 503 X\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
        );
        s.end();
      });
      const o = await via(base);
      expect(seen.full).toBe(1);
      expect(o.requestNotSent).toBe(false);
    },
  );

  it.each(clients)(
    '%s: a request read and never answered (the deadline passes) is not marked',
    async (_n, via) => {
      const { base, seen } = await raw(() => undefined);
      const o = await via(base, 400);
      expect(seen.full).toBe(1);
      expect(o.requestNotSent).toBe(false);
    },
  );
});
