import { Socket } from 'node:net';

/**
 * Fails a spec that reaches any host but this machine (task NUV-01: "No spec
 * reaches a host other than the stand-in"). Every TCP connection in the
 * process goes through `net.Socket.prototype.connect` (fetch, http, https,
 * tls and the database driver alike); while the guard is on, a connection
 * to anything but a loopback address is destroyed before a byte or a DNS
 * lookup leaves, and recorded. The spec asserts `violations` is empty.
 *
 * Loopback is the stand-ins (Nuvion's, WAWU ID's) on their own ports and
 * the local test database. No Nuvion, Fintava or wawuafrica.com host is
 * loopback, so none of them can be reached.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

export interface OutboundGuard {
  /** `host:port` of every refused connection, in order. */
  readonly violations: string[];
  restore(): void;
}

type ConnectArgs = unknown[];

function target(args: ConnectArgs): { host: string; port: string } | null {
  const [first, second] = args;
  if (Array.isArray(first)) return target(first as ConnectArgs);
  if (typeof first === 'object' && first !== null) {
    const o = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof o.path === 'string') return null; // a local IPC socket
    return {
      host: typeof o.host === 'string' ? o.host : 'localhost',
      port: String(o.port ?? ''),
    };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return {
      host: typeof second === 'string' ? second : 'localhost',
      port: String(first),
    };
  }
  if (typeof first === 'string') return null; // a path
  return null;
}

export function guardOutbound(): OutboundGuard {
  const violations: string[] = [];
  const original = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: ConnectArgs) {
    const t = target(args);
    if (t && !LOOPBACK.has(t.host.replace(/^\[|\]$/g, '').toLowerCase())) {
      violations.push(`${t.host}:${t.port}`);
      process.nextTick(() =>
        this.destroy(new Error(`outbound connection blocked: ${t.host}`)),
      );
      return this;
    }
    return (original as (...a: ConnectArgs) => Socket).apply(this, args);
  } as typeof Socket.prototype.connect;
  return {
    violations,
    restore: () => {
      Socket.prototype.connect = original;
    },
  };
}
