import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { RigRow } from '../../../test/netns/connection-never-opened-rig';

/**
 * MONEY-18 round 3, R2-1, on real sockets and a real failing network.
 *
 * `requestNotSent` lets a release or a refund be sent AGAIN under the same
 * reference, so it may be true only when the request provably never left. The
 * error code alone cannot say: Node raises ECONNREFUSED, ENETUNREACH and
 * EHOSTUNREACH both while connecting (nothing sent) and on an established
 * connection when the route fails under it after the provider read the whole
 * request (`read EHOSTUNREACH`). The syscall tells the two apart.
 *
 * The second kind cannot be made without a network that fails on purpose, so
 * this spec runs the rig (`test/netns/connection-never-opened-rig.ts`) in a
 * PRIVATE network namespace (`unshare -n`: loopback only, `iptables` to drop
 * the server's replies and to answer the client's retransmissions with ICMP
 * errors, `tcp_retries2` lowered so the kernel gives up before the client's
 * deadline). The rig drives the real `FintavaClient` and `NuvionClient`
 * against raw TCP servers and reports what each marked and what the server
 * really read.
 *
 * It needs root (or `sudo -n`, or user namespaces), `unshare`, `iptables`,
 * `sysctl` and a way to raise loopback (`ip`, or python3). Where a private
 * namespace cannot be made it is not run (the title says so): the fixtures in
 * `connection-never-opened.spec.ts`, which carry the syscalls real errors
 * carry, still run everywhere. The rig is also a script, see its header.
 */

const ROOT = resolve(__dirname, '../../..');

// Loopback up (`ip` if there is one, else the ioctl), a low retransmission
// limit, and iptables reachable: the namespace is only usable if all three work.
const PRELUDE = [
  `(ip link set lo up 2>/dev/null || python3 -c "import fcntl,socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack('16sH14s',fcntl.ioctl(s,0x8913,struct.pack('16sH14s',b'lo',0,b'')))[1];fcntl.ioctl(s,0x8914,struct.pack('16sH14s',b'lo',f|1,b''))")`,
  'sysctl -w net.ipv4.tcp_retries2=3 >/dev/null',
  'iptables -w 5 -S OUTPUT >/dev/null',
].join(' && ');

const LAUNCHERS: string[][] = [
  ['unshare', '-n'],
  ['sudo', '-n', 'unshare', '-n'],
  ['unshare', '-rn'],
];

/** The first way of making a private network namespace that works here. */
function findLauncher(): string[] | null {
  for (const l of LAUNCHERS) {
    const [cmd, ...args] = l;
    const r = spawnSync(cmd, [...args, 'sh', '-c', PRELUDE], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    if (r.status === 0) return l;
  }
  return null;
}

const LAUNCHER = findLauncher();
const itPrivateNamespace = LAUNCHER ? it : it.skip;

const EXPECTED_SCENARIOS = [
  'closed port',
  'closed port by name (localhost)',
  'name that does not resolve',
  'no route (10.255.255.1)',
  'deadline passes while connecting',
  'connect timeout (undici, before the deadline)',
  'EHOSTUNREACH on a read, after the whole request was read (icmp-host-unreachable)',
  'ENETUNREACH on a read, after the whole request was read (icmp-net-unreachable)',
  'ECONNREFUSED on a read, after the whole request was read (icmp-port-unreachable)',
];

function runRig(
  launcher: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  const [cmd, ...args] = launcher;
  const script = `${PRELUDE} && exec "${process.execPath}" -r ts-node/register/transpile-only test/netns/connection-never-opened-rig.ts`;
  return new Promise((done) => {
    const child = spawn(cmd, [...args, 'sh', '-c', script], {
      cwd: ROOT,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
  });
}

describe('connectionNeverOpened on real sockets in a private network namespace', () => {
  itPrivateNamespace(
    'marks a request that never left, and none that the provider read (needs a private network namespace: root or sudo, unshare, iptables)',
    async () => {
      const r = await runRig(LAUNCHER as string[]);
      const rows = r.out
        .split('\n')
        .filter((l) => l.startsWith('ROW '))
        .map((l) => JSON.parse(l.slice(4)) as RigRow);
      // The rig finished by itself and reported every scenario.
      expect({
        code: r.code,
        done: /^DONE /m.test(r.out),
        err: r.err.slice(0, 500),
      }).toEqual({
        code: 0,
        done: true,
        err: '',
      });
      expect([...new Set(rows.map((x) => x.scenario))].sort()).toEqual(
        [...EXPECTED_SCENARIOS].sort(),
      );

      // Every row: marked exactly when the scenario says nothing was sent.
      const wrong = rows.filter((x) => !x.ok);
      expect(
        wrong.map(
          (x) => `${x.client}: ${x.scenario} marked=${x.requestNotSent}`,
        ),
      ).toEqual([]);

      // The route that fails AFTER the write: the server really read the whole
      // request (so the case is not vacuous), and neither client marked it.
      const afterWrite = rows.filter((x) => x.scenario.includes('on a read'));
      expect(afterWrite).toHaveLength(6);
      for (const x of afterWrite) {
        expect(x.fullRequests).toBe(1);
        expect(x.serverBytes).toBeGreaterThan(300);
        expect(x.requestNotSent).toBe(false);
        expect(x.recordMayExist).toBe(true);
        expect(x.kind).toBe('outcome_unknown');
      }

      // What was marked read nothing; the four ways of never connecting and the
      // connect-phase timeout are all marked, for every client the rig drove.
      const marked = rows.filter((x) => x.requestNotSent);
      for (const x of marked) expect(x.serverBytes).toBe(0);
      expect([...new Set(marked.map((x) => x.scenario))].sort()).toEqual(
        [
          'closed port',
          'closed port by name (localhost)',
          'connect timeout (undici, before the deadline)',
          'name that does not resolve',
          'no route (10.255.255.1)',
        ].sort(),
      );
      // Our own deadline passing while connecting is a plain timeout.
      for (const x of rows.filter(
        (y) => y.scenario === 'deadline passes while connecting',
      )) {
        expect(x.requestNotSent).toBe(false);
      }
    },
    180_000,
  );
});
