import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { Logger } from '@nestjs/common';
import { fintavaConfig } from '../../../test/fintava/fintava-double';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import { FintavaClient } from '../../fintava/fintava-client';
import { FintavaError } from '../../fintava/fintava-error';
import { toWalletProviderError } from '../../fintava/fintava-wallet-provider';
import { NuvionClient, type NuvionOp } from '../../nuvion/nuvion-client';
import {
  CONNECTION_NEVER_OPENED_CODES,
  connectionNeverOpened,
} from '../connection-never-opened';
import { WalletProviderError } from '../wallet-provider-error';

/**
 * MONEY-18 round 2, O1: a request that provably never reached the provider
 * (the connection was refused, the host name did not resolve) is marked
 * `requestNotSent`, so a release or refund can be sent again under the same
 * reference; every other loss is still an unknown outcome that is asked
 * about and never sent again.
 */

const withCode = (code: string, extra: object = {}) =>
  Object.assign(new Error(`connect ${code}`), { code, ...extra });
const fetchFailed = (cause: unknown) =>
  Object.assign(new TypeError('fetch failed'), { cause });

describe('connectionNeverOpened (the shape of a failed fetch)', () => {
  it.each([...CONNECTION_NEVER_OPENED_CODES])(
    '%s under fetch failed: the request was not sent',
    (code) => {
      expect(connectionNeverOpened(fetchFailed(withCode(code)))).toBe(true);
    },
  );

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
    expect(connectionNeverOpened(e)).toBe(true);
  });

  it('an address list that was refused one by one (an AggregateError) is not sent, but not if one of them failed another way', () => {
    const refused = Object.assign(
      new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')]),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionNeverOpened(fetchFailed(refused))).toBe(true);
    const mixed = Object.assign(
      new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNRESET')]),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionNeverOpened(fetchFailed(mixed))).toBe(false);
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
    let deep: unknown = withCode('ECONNREFUSED');
    for (let i = 0; i < 12; i += 1) deep = new Error('wrap', { cause: deep });
    expect(connectionNeverOpened(deep)).toBe(false);
    const loop = new Error('loop');
    (loop as { cause?: unknown }).cause = loop;
    expect(connectionNeverOpened(loop)).toBe(false);
  });

  it('an error from another realm (a jest sandbox) is read the same way', () => {
    const foreign = runInNewContext(
      "Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) })",
    ) as unknown;
    expect(foreign instanceof Error).toBe(false);
    expect(connectionNeverOpened(foreign)).toBe(true);
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
