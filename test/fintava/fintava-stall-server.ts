import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { MERCHANT_BALANCE } from './fintava-double';

/**
 * A raw TCP stand-in for a Fintava that answers badly (task FIX-01). It
 * speaks just enough HTTP/1.1 to be read by `fetch`, and nothing here
 * reaches the internet. The first path segment picks the behaviour, so one
 * server serves every case (`baseUrl(mode)` is the client's base URL):
 *
 * - `silent`: reads the request and never answers (no headers at all).
 * - `stall-<status>`: sends the status line and headers with
 *   `Content-Length: 4096`, then the first bytes of a JSON body, then
 *   nothing more, ever.
 * - `drip-<status>`: the same headers, then one byte every 50 ms, forever
 *   (a body that keeps arriving but never ends inside the deadline).
 * - `late-<ms>`: the headers at once and a whole, valid JSON body `<ms>`
 *   later (a slow body that still finishes).
 *
 * `headersSent()` resolves when a stalled or dripping answer has written its
 * headers, which is when a test forces garbage collection.
 */

export type StallMode =
  'silent' | `stall-${number}` | `drip-${number}` | `late-${number}`;

/** The body `late-<ms>` sends: the sandbox's merchant balance answer. */
export const LATE_BODY = JSON.stringify(MERCHANT_BALANCE);

export class FintavaStallServer {
  private server: Server | null = null;
  private port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private waiting: Array<() => void> = [];
  /** Sockets the client has closed (or that ended), counted. */
  closed = 0;
  opened = 0;

  baseUrl(mode: StallMode): string {
    return `http://127.0.0.1:${this.port}/${mode}/api/dev`;
  }

  /** Resolves the next time headers are sent on a stalled or dripping answer. */
  headersSent(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    this.opened += 1;
    this.sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed += 1;
      this.sockets.delete(socket);
    });
    let head = '';
    let answered = false;
    socket.on('data', (chunk: Buffer) => {
      if (answered) return;
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      answered = true;
      const path = head.split(' ')[1] ?? '';
      this.answer(socket, path.split('/')[1] ?? '');
    });
  }

  private answer(socket: Socket, mode: string): void {
    if (mode === 'silent') return;
    const [kind, arg] = mode.split('-');
    const n = Number(arg);
    if (kind === 'late') {
      socket.write(
        'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n' +
          `content-length: ${Buffer.byteLength(LATE_BODY)}\r\n\r\n`,
      );
      this.later(() => socket.end(LATE_BODY), n);
      return;
    }
    socket.write(
      `HTTP/1.1 ${n} Answer\r\ncontent-type: application/json\r\n` +
        'content-length: 4096\r\n\r\n',
    );
    if (kind === 'stall') {
      socket.write('{"status":');
    } else {
      const drip = () => {
        if (socket.destroyed) return;
        socket.write(' ');
        this.later(drip, 50);
      };
      drip();
    }
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
}
