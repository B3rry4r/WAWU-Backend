/**
 * Real-socket rig for `connectionNeverOpened` (MONEY-18 round 3, R2-1).
 *
 * Runs the real `FintavaClient` and the real `NuvionClient` against raw TCP
 * servers and reports, for each scenario, whether the client marked the
 * request `requestNotSent` and how many bytes the server really read. The
 * point is the cases the error code cannot tell apart: a connection refused
 * or an unreachable route while the connection is being made (nothing was
 * sent) against the same codes raised on an established connection after the
 * provider read the whole request (`read EHOSTUNREACH`).
 *
 * The second kind needs a network that fails on purpose: the server drops its
 * replies and the first hop answers the client's retransmissions with an ICMP
 * error, and the kernel's retransmission limit is lowered so the socket dies
 * before the client's own deadline. That takes iptables and sysctl in a
 * PRIVATE network namespace. The rig therefore refuses to start unless the
 * only interface is loopback (it flushes the OUTPUT chain), and it is run by
 * `connection-never-opened-sockets.spec.ts` under `unshare -n`. By hand:
 *
 *   unshare -n sh -c 'ip link set lo up; \
 *     sysctl -w net.ipv4.tcp_retries2=3; \
 *     node -r ts-node/register/transpile-only \
 *       test/netns/connection-never-opened-rig.ts'
 *
 * (as root; `ip link set lo up` can be any way of raising loopback). One
 * `ROW {json}` line per client per scenario on stdout, then `DONE`.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Logger } from '@nestjs/common';
import { FintavaClient } from '../../src/fintava/fintava-client';
import { NuvionClient, type NuvionOp } from '../../src/nuvion/nuvion-client';
import { fintavaConfig } from '../fintava/fintava-double';
import { NuvionStandin } from '../nuvion/nuvion-standin';

export type RigRow = {
  scenario: string;
  client: 'fintava' | 'nuvion';
  /** What the classifier must say for this scenario. */
  expectNotSent: boolean;
  kind: string;
  recordMayExist: boolean;
  requestNotSent: boolean;
  /** Bytes the server read, and how many whole requests that made. */
  serverBytes: number;
  fullRequests: number;
  ms: number;
  ok: boolean;
};

type Seen = { connections: number; bytes: number; full: number };
type Outcome = {
  kind: string;
  recordMayExist: boolean;
  requestNotSent: boolean;
};

const KEY = 'live_test_rig_0123456789FAKEKEY';
const NKEY = 'nv_test_sk_rigstandinKEY0123456789abcdef';
const WRITE: NuvionOp = { name: 'make thing', call: 'write' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ipt = (...a: string[]) =>
  execFileSync('iptables', ['-w', '5', ...a], { stdio: 'pipe' });

function money(ref: string) {
  return {
    senderAccountNumber: '1102000001',
    receiverAccountNumber: '1102000002',
    amountKobo: 100_000,
    customerReference: ref,
    narration: 'WAWU earning',
  };
}

async function viaFintava(
  baseUrl: string,
  ref: string,
  timeoutMs: number,
): Promise<Outcome | 'ok'> {
  const c = new FintavaClient(
    fintavaConfig({
      FINTAVA_BASE_URL: baseUrl,
      FINTAVA_API_KEY: KEY,
      FINTAVA_TIMEOUT_MS: String(timeoutMs),
      FINTAVA_MONEY_TIMEOUT_MS: String(timeoutMs),
      FINTAVA_CHECK_TIMEOUT_MS: String(timeoutMs),
    }),
  );
  try {
    await c.walletToWallet(money(ref));
    return 'ok';
  } catch (e) {
    const err = e as Outcome;
    return {
      kind: err.kind,
      recordMayExist: err.recordMayExist,
      requestNotSent: err.requestNotSent,
    };
  }
}

async function viaNuvion(
  baseUrl: string,
  ref: string,
  timeoutMs: number,
): Promise<Outcome | 'ok'> {
  const client = new NuvionClient(
    new NuvionStandin().settings({
      baseUrl,
      moneyTimeoutMs: timeoutMs,
      readTimeoutMs: timeoutMs,
      checkTimeoutMs: timeoutMs,
    }),
    NKEY,
  );
  try {
    await client.post(WRITE, '/transfers', {}, { reference: ref });
    return 'ok';
  } catch (e) {
    const err = e as Outcome;
    return {
      kind: err.kind,
      recordMayExist: err.recordMayExist,
      requestNotSent: err.requestNotSent,
    };
  }
}

/** A raw TCP server that counts what it read; `onFull` fires once the whole POST is in. */
function rawServer(
  onFull: (s: Socket, port: number) => void,
): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = { connections: 0, bytes: 0, full: 0 };
  return new Promise((resolve) => {
    let port = 0;
    const server = createServer((s) => {
      seen.connections += 1;
      let buf = Buffer.alloc(0);
      let fired = false;
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
          onFull(s, port);
        }
      });
      s.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, seen });
    });
  });
}

const rows: RigRow[] = [];

function report(
  scenario: string,
  client: 'fintava' | 'nuvion',
  expectNotSent: boolean,
  o: Outcome | 'ok',
  seen: Seen | null,
  started: number,
) {
  const out: Outcome =
    o === 'ok'
      ? { kind: 'ok', recordMayExist: false, requestNotSent: false }
      : o;
  const row: RigRow = {
    scenario,
    client,
    expectNotSent,
    ...out,
    serverBytes: seen?.bytes ?? 0,
    fullRequests: seen?.full ?? 0,
    ms: Date.now() - started,
    ok:
      out.requestNotSent === expectNotSent &&
      // Marked "never sent" and yet the server read bytes: never acceptable.
      !(out.requestNotSent && (seen?.bytes ?? 0) > 0),
  };
  rows.push(row);
  console.log(`ROW ${JSON.stringify(row)}`);
}

async function both(
  scenario: string,
  expectNotSent: boolean,
  baseFor: () => Promise<{ base: string; seen: Seen | null; done: () => void }>,
  timeoutMs: number,
  clients: readonly ('fintava' | 'nuvion')[] = ['fintava', 'nuvion'],
) {
  await Promise.all(
    clients.map(async (client) => {
      const { base, seen, done } = await baseFor();
      const started = Date.now();
      const ref = `wawu-rig-${scenario.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`;
      const o =
        client === 'fintava'
          ? await viaFintava(base, ref, timeoutMs)
          : await viaNuvion(base, ref, timeoutMs);
      report(scenario, client, expectNotSent, o, seen, started);
      done();
    }),
  );
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function main() {
  const names = Object.keys(networkInterfaces());
  if (names.length !== 1 || names[0] !== 'lo') {
    console.error(
      `refusing to run: this is not a private network namespace (interfaces: ${names.join(', ')})`,
    );
    process.exit(2);
  }
  Logger.overrideLogger(false);
  ipt('-F', 'OUTPUT');

  // 1. The connection is being made, and fails: nothing was sent.
  const closed = await closedPort();
  await both(
    'closed port',
    true,
    () =>
      Promise.resolve({
        base: `http://127.0.0.1:${closed}/api/dev`,
        seen: null,
        done: () => undefined,
      }),
    5_000,
  );
  await both(
    'closed port by name (localhost)',
    true,
    () =>
      Promise.resolve({
        base: `http://localhost:${closed}/api/dev`,
        seen: null,
        done: () => undefined,
      }),
    5_000,
  );
  await both(
    'name that does not resolve',
    true,
    () =>
      Promise.resolve({
        base: 'http://no-such-host.invalid/api/dev',
        seen: null,
        done: () => undefined,
      }),
    5_000,
    // FintavaClient takes only its own hosts (and loopback), so only Nuvion's
    // client is pointed at a made-up name or address; both share the classifier.
    ['nuvion'],
  );
  await both(
    'no route (10.255.255.1)',
    true,
    () =>
      Promise.resolve({
        base: 'http://10.255.255.1:6063/api/dev',
        seen: null,
        done: () => undefined,
      }),
    5_000,
    ['nuvion'],
  );

  // 2. The connect itself hangs (SYN dropped): undici's connect timeout is
  //    the connect phase's own and counts; our deadline passing first does not.
  const hole = await rawServer(() => undefined);
  ipt(
    '-A',
    'OUTPUT',
    '-p',
    'tcp',
    '--dport',
    String(hole.port),
    '--tcp-flags',
    'SYN,ACK',
    'SYN',
    '-j',
    'DROP',
  );
  const holeBase = `http://127.0.0.1:${hole.port}/api/dev`;
  const holeStep = () =>
    Promise.resolve({ base: holeBase, seen: hole.seen, done: () => undefined });
  // (a) a long deadline: undici's 10 s connect timer fires first.
  // (b) a short deadline: ours passes first, whatever the line was doing.
  await Promise.all([
    both(
      'connect timeout (undici, before the deadline)',
      true,
      holeStep,
      30_000,
    ),
    both('deadline passes while connecting', false, holeStep, 1_500),
  ]);
  hole.server.close();
  ipt('-F', 'OUTPUT');

  // 3. The route fails AFTER the provider read the whole request. The same
  //    codes, raised on an established connection (`read EHOSTUNREACH`):
  //    the request was sent and the money may have moved.
  await Promise.all(
    (
      [
        ['icmp-host-unreachable', 'EHOSTUNREACH'],
        ['icmp-net-unreachable', 'ENETUNREACH'],
        ['icmp-port-unreachable', 'ECONNREFUSED'],
      ] as const
    ).map(([reject, code]) =>
      both(
        `${code} on a read, after the whole request was read (${reject})`,
        false,
        async () => {
          execFileSync('sysctl', ['-w', 'net.ipv4.tcp_retries2=3'], {
            stdio: 'pipe',
          });
          const mk = await rawServer((_s, port) => {
            // The server has the whole request. From here on its replies
            // never arrive, and the client's retransmissions get an ICMP
            // error from the first hop.
            ipt(
              '-I',
              'OUTPUT',
              '1',
              '-p',
              'tcp',
              '--dport',
              String(port),
              '-j',
              'REJECT',
              '--reject-with',
              reject,
            );
          });
          ipt(
            '-A',
            'OUTPUT',
            '-p',
            'tcp',
            '--sport',
            String(mk.port),
            '--tcp-flags',
            'SYN',
            'SYN',
            '-j',
            'ACCEPT',
          );
          ipt(
            '-A',
            'OUTPUT',
            '-p',
            'tcp',
            '--sport',
            String(mk.port),
            '-j',
            'DROP',
          );
          return {
            base: `http://127.0.0.1:${mk.port}/api/dev`,
            seen: mk.seen,
            done: () => mk.server.close(),
          };
        },
        60_000,
      ),
    ),
  );
  await sleep(50);
  ipt('-F', 'OUTPUT');
  const bad = rows.filter((r) => !r.ok);
  console.log(`DONE rows=${rows.length} notOk=${bad.length}`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
