import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { fintavaConfig } from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';
import { SELFIE_ANSWER_MAX_BYTES } from '../fintava-selfie-answer';

/**
 * KYC-02 verifier round 3, defect 2: the selfie answer is read with a size
 * cap, while it arrives. A huge, endless or slow answer, of any status, is
 * dropped as soon as it passes SELFIE_ANSWER_MAX_BYTES (or declares a
 * longer Content-Length): `bad_response` (the route's counted 503), never a
 * match, never buffered or parsed. Before the cap a 200 MB answer held the
 * event loop for about 48 s and an endless one until the 30 s check
 * timeout.
 *
 * A raw TCP server writes every byte, so the test controls the headers,
 * the pace and what is written after the client stops reading.
 */

const CAP = SELFIE_ANSWER_MAX_BYTES;
const ACCEPTED = '{"data":{"match":true},"status":200,"message":"successful"}';
const IMAGE = Buffer.alloc(3000, 7).toString('base64');
/** Well under a second after the cap is passed. */
const QUICK_MS = 500;

/** What the server saw of one answer. */
interface Sent {
  /** Body bytes written to the socket. */
  bytes: number;
  /** When the body passed the cap (ms since epoch), or null. */
  passedCapAt: number | null;
  /** When the client dropped the connection, or null. */
  closedAt: number | null;
}

type Writer = (sock: Socket, sent: Sent) => void;
let writer: Writer = () => undefined;
let sent: Sent;
let server: Server;
let base = '';
const sockets = new Set<Socket>();
const timers = new Set<NodeJS.Timeout>();

beforeAll(async () => {
  server = createServer((sock) => {
    let head = '';
    let answered = false;
    sock.on('data', (d) => {
      if (answered) return;
      head += d.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(head.slice(0, end));
      if (head.length < end + 4 + (m ? Number(m[1]) : 0)) return;
      answered = true;
      // Only answered connections are closed after each test: undici may
      // open the next one early, and that one must survive.
      sockets.add(sock);
      writer(sock, sent);
    });
    sock.on('close', () => {
      sockets.delete(sock);
      if (sent.closedAt === null) sent.closedAt = Date.now();
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dev`;
});

afterEach(() => {
  for (const t of timers) clearInterval(t);
  timers.clear();
  for (const s of sockets) s.destroy();
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function head(status: number, extra: string[]): string {
  return (
    [
      `HTTP/1.1 ${status} X`,
      'content-type: application/json; charset=utf-8',
      ...extra,
      'connection: close',
    ].join('\r\n') + '\r\n\r\n'
  );
}

/** Counts body bytes and notes when they pass the cap. */
function wrote(s: Sent, n: number): void {
  s.bytes += n;
  if (s.passedCapAt === null && s.bytes > CAP) s.passedCapAt = Date.now();
}

/** A whole body with its Content-Length, written in one go. */
const whole =
  (status: number, body: Buffer, extra: string[] = []): Writer =>
  (sock, s) => {
    sock.write(head(status, [`content-length: ${body.length}`, ...extra]));
    wrote(s, body.length);
    sock.end(body);
  };

/**
 * `total` bytes of a JSON string value, chunked (no Content-Length), as
 * fast as the socket takes them; stops when the client drops it.
 */
const flood =
  (status: number, total: number): Writer =>
  (sock, s) => {
    sock.write(head(status, ['transfer-encoding: chunked']));
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const frame = (b: Buffer) =>
      Buffer.concat([
        Buffer.from(`${b.length.toString(16)}\r\n`),
        b,
        Buffer.from('\r\n'),
      ]);
    const opening = Buffer.from('{"data":{"match":true},"status":200,"x":"');
    sock.write(frame(opening));
    wrote(s, opening.length);
    const pump = () => {
      while (!sock.destroyed && s.bytes < total) {
        wrote(s, chunk.length);
        if (!sock.write(frame(chunk))) {
          sock.once('drain', pump);
          return;
        }
      }
      if (!sock.destroyed) {
        sock.write(frame(Buffer.from('"}')));
        sock.end('0\r\n\r\n');
      }
    };
    pump();
  };

/** An endless body: `bytes` more every `everyMs`, until the client drops it. */
const trickle =
  (status: number, bytes: number, everyMs: number): Writer =>
  (sock, s) => {
    sock.write(head(status, ['transfer-encoding: chunked']));
    const piece = Buffer.alloc(bytes, 0x20);
    const t = setInterval(() => {
      if (sock.destroyed) return clearInterval(t);
      wrote(s, piece.length);
      sock.write(`${piece.length.toString(16)}\r\n`);
      sock.write(piece);
      sock.write('\r\n');
    }, everyMs);
    timers.add(t);
  };

interface Outcome {
  kind: string;
  httpStatus: number | null;
  /** From the request to the answer. */
  ms: number;
  /** From the body passing the cap (or the headers, for a declared length) to the answer. */
  afterCapMs: number | null;
}

async function selfie(w: Writer): Promise<Outcome> {
  writer = w;
  sent = { bytes: 0, passedCapAt: null, closedAt: null };
  const client = new FintavaClient(
    fintavaConfig({ FINTAVA_BASE_URL: base, FINTAVA_API_KEY: 'k_size_FAKE' }),
  );
  const t0 = Date.now();
  let kind = 'match';
  let httpStatus: number | null = null;
  try {
    const r = await client.verifyBvnSelfie({
      bvn: '22290000111',
      imageBase64: IMAGE,
    });
    kind = r.matched ? 'match' : 'no';
  } catch (e) {
    if (!(e instanceof FintavaError)) throw e;
    kind = e.kind;
    httpStatus = e.httpStatus;
  }
  const now = Date.now();
  return {
    kind,
    httpStatus,
    ms: now - t0,
    afterCapMs: sent.passedCapAt === null ? null : now - sent.passedCapAt,
  };
}

/** The connection is closed by the client within a moment of the answer. */
async function closedSoon(): Promise<number | null> {
  for (let i = 0; i < 50 && sent.closedAt === null; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return sent.closedAt;
}

describe('the selfie answer is read with a size cap (verifier round 3, defect 2)', () => {
  it('the cap is a few KB: every readable answer is under 200 bytes', () => {
    expect(CAP).toBe(4096);
  });

  it('a 200 MB answer with its Content-Length ends at once as bad_response, nothing of the body read', async () => {
    const body = Buffer.concat([
      Buffer.from('{"data":{"match":true},"status":200,"x":"'),
      Buffer.alloc(200_000_000, 0x41),
      Buffer.from('"}'),
    ]);
    const o = await selfie(whole(200, body));
    expect({ kind: o.kind, status: o.httpStatus }).toEqual({
      kind: 'bad_response',
      status: 200,
    });
    expect(o.ms).toBeLessThan(QUICK_MS);
    expect(await closedSoon()).not.toBeNull();
  }, 120_000);

  it('a 200 MB answer with no Content-Length (chunked) ends as bad_response well under a second after the cap, and the connection is dropped', async () => {
    const o = await selfie(flood(200, 200_000_000));
    expect(o.kind).toBe('bad_response');
    expect(o.afterCapMs).not.toBeNull();
    expect(o.afterCapMs!).toBeLessThan(QUICK_MS);
    expect(o.ms).toBeLessThan(QUICK_MS * 2);
    expect(await closedSoon()).not.toBeNull();
    // Far less than the 200 MB was ever written: the client stopped reading.
    expect(sent.bytes).toBeLessThan(20_000_000);
  }, 120_000);

  it('an endless slow answer (512 bytes every 20 ms) ends as bad_response well under a second after the cap, not at the 30 s timeout', async () => {
    const o = await selfie(trickle(200, 512, 20));
    expect(o.kind).toBe('bad_response');
    expect(o.afterCapMs).not.toBeNull();
    expect(o.afterCapMs!).toBeLessThan(QUICK_MS);
    expect(await closedSoon()).not.toBeNull();
    const writtenAtClose = sent.bytes;
    // Nothing more is written once the client has gone.
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.bytes).toBe(writtenAtClose);
  }, 120_000);

  it('a declared Content-Length over the cap ends as bad_response at once, without waiting for a body that never comes', async () => {
    const o = await selfie((sock) => {
      sock.write(head(200, [`content-length: ${CAP + 1}`]));
      // ...and nothing more: the body never arrives.
    });
    expect(o.kind).toBe('bad_response');
    expect(o.ms).toBeLessThan(QUICK_MS);
  }, 120_000);

  it('a failure status over the cap is bad_response too (not read as a failed match, or a refused key)', async () => {
    for (const status of [400, 401, 500]) {
      const big = Buffer.from(
        JSON.stringify({
          status,
          timestamp: '2026-10-02T09:43:35.262Z',
          message: ['Request failed with status code 404', 'x'.repeat(CAP)],
          path: '/api/dev/compliance/verify/bvn/selfie',
        }),
      );
      const declared = await selfie(whole(status, big));
      expect({ status, kind: declared.kind }).toEqual({
        status,
        kind: 'bad_response',
      });
      const streamed = await selfie(trickle(status, 512, 20));
      expect({ status, kind: streamed.kind }).toEqual({
        status,
        kind: 'bad_response',
      });
      expect(streamed.afterCapMs!).toBeLessThan(QUICK_MS);
    }
  }, 120_000);

  it('the cap counts the decoded bytes: a small gzip that inflates past it is bad_response', async () => {
    const inflated = Buffer.concat([
      Buffer.from('{"data":{"match":true},'),
      Buffer.alloc(1_000_000, 0x20),
      Buffer.from('"status":200}'),
    ]);
    const gz = gzipSync(inflated);
    expect(gz.length).toBeLessThan(CAP);
    const o = await selfie(whole(200, gz, ['content-encoding: gzip']));
    expect(o.kind).toBe('bad_response');
    expect(o.ms).toBeLessThan(QUICK_MS);
  }, 120_000);

  it('an answer of exactly the cap is read; one byte more is not', async () => {
    const at = (n: number) =>
      Buffer.from(ACCEPTED.replace('{', `{${' '.repeat(n - ACCEPTED.length)}`));
    expect(at(CAP).length).toBe(CAP);
    // JSON whitespace around the accepted shape is still the accepted shape.
    expect((await selfie(whole(200, at(CAP)))).kind).toBe('match');
    expect((await selfie(whole(200, at(CAP + 1)))).kind).toBe('bad_response');
    // The same without a Content-Length: counted as it arrives.
    const chunked =
      (body: Buffer): Writer =>
      (sock, s) => {
        sock.write(head(200, ['transfer-encoding: chunked']));
        for (let i = 0; i < body.length; i += 1000) {
          const part = body.subarray(i, i + 1000);
          wrote(s, part.length);
          sock.write(`${part.length.toString(16)}\r\n`);
          sock.write(part);
          sock.write('\r\n');
        }
        sock.end('0\r\n\r\n');
      };
    expect((await selfie(chunked(at(CAP)))).kind).toBe('match');
    expect((await selfie(chunked(at(CAP + 1)))).kind).toBe('bad_response');
  }, 120_000);

  it('the real failed match (150 bytes) is still identity_refused', async () => {
    const body = Buffer.from(
      JSON.stringify({
        status: 400,
        timestamp: '2026-10-02T09:43:35.262Z',
        message: ['Request failed with status code 404'],
        path: '/api/dev/compliance/verify/bvn/selfie',
      }),
    );
    expect(body.length).toBe(150);
    expect((await selfie(whole(400, body))).kind).toBe('identity_refused');
  });
});
