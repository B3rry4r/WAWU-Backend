import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { hubTrustProxy } from '../hub-app-options';
import { encodeLiveCursor } from './live-cursor';
import {
  LiveConnections,
  type LiveConnection,
} from './live-connections.service';
import { LiveListener } from './live-listener.service';
import { LIVE_CLOSE, LIVE_LIMITS } from './live-limits';
import { LiveTokenVerifier } from './live-token.verifier';
import type { LiveReadyFrame } from './live-event.type';

/**
 * The WebSocket at `/api/hub/live` (task INBOX-02).
 *
 * It rides on the Hub's own HTTP server, upgraded by path, so nothing in
 * `main.ts` changes and nginx needs nothing it does not already have (the
 * `Upgrade` headers and a 120 s read timeout are in deploy/install-services.sh;
 * the heartbeat below keeps a quiet socket inside that timeout).
 *
 * Signing in: the WAWU ID access token, either as `Authorization: Bearer` on
 * the upgrade request (the phone app) or as the first frame, `{"type":"auth",
 * "token":"..."}` (browsers cannot set headers on a socket). A token is never
 * read from the URL, where it would end up in logs. A socket with no valid
 * token within a few seconds is closed. A new token can be sent the same way at
 * any time; a socket whose token runs out is closed with 4401, and the app
 * reconnects with a fresh one.
 *
 * Nothing is subscribed: a person receives events for the chats and
 * communities they are in, decided per event by LiveDispatcher.
 */
@Injectable()
export class LiveGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(LiveGateway.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIVE_LIMITS.maxFrameBytes,
  });
  private heartbeat: NodeJS.Timeout | undefined;
  /** Sockets from each address that have not signed in yet. */
  private readonly unsigned = new Map<string, number>();
  private onUpgrade:
    ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly connections: LiveConnections,
    private readonly listener: LiveListener,
    private readonly tokens: LiveTokenVerifier,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.onUpgrade = (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      const isSocket =
        String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
      if (path !== LIVE_LIMITS.path || !isSocket) {
        handBack(server, req, socket, head);
        return;
      }
      if (!this.listener.isUp) {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      const address = addressOf(req);
      if ((this.unsigned.get(address) ?? 0) >= LIVE_LIMITS.unsignedPerAddress) {
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.accept(ws, req, address),
      );
    };
    server.on('upgrade', this.onUpgrade);
    this.heartbeat = setInterval(() => this.beat(), LIVE_LIMITS.heartbeatMs);
    this.heartbeat.unref();
    // Without `enableShutdownHooks` (main.ts has none) Nest never hears a
    // SIGTERM, so a restart would cut every socket with no close frame. The
    // gateway tells its sockets 1001 itself, then lets the signal do what it
    // would have done.
    for (const signal of STOP_SIGNALS) process.on(signal, this.onStopSignal);
  }

  onApplicationShutdown(): void {
    clearInterval(this.heartbeat);
    for (const signal of STOP_SIGNALS) {
      process.removeListener(signal, this.onStopSignal);
    }
    this.connections.closeAll(LIVE_CLOSE.goingAway, 'shutting down');
    this.wss.close();
  }

  private readonly onStopSignal = (signal: NodeJS.Signals): void => {
    const closed = this.connections
      .all()
      .map(
        (c) =>
          new Promise<void>((resolve) => c.ws.once('close', () => resolve())),
      );
    this.connections.closeAll(LIVE_CLOSE.goingAway, 'shutting down');
    const flushed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LIVE_LIMITS.shutdownFlushMs);
      void Promise.all(closed).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    void flushed.then(() => {
      for (const s of STOP_SIGNALS) {
        process.removeListener(s, this.onStopSignal);
      }
      // If nothing else is handling the signal, do what it does by default.
      if (process.listenerCount(signal) === 0)
        process.kill(process.pid, signal);
    });
  };

  private beat(): void {
    for (const conn of this.connections.all()) {
      if (!conn.alive) {
        this.connections.remove(conn);
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }

  private accept(ws: WebSocket, req: IncomingMessage, address: string): void {
    let conn: LiveConnection | undefined;
    this.unsigned.set(address, (this.unsigned.get(address) ?? 0) + 1);
    let counted = true;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      const left = (this.unsigned.get(address) ?? 1) - 1;
      if (left <= 0) this.unsigned.delete(address);
      else this.unsigned.set(address, left);
    };
    const authTimer = setTimeout(() => {
      if (!conn) ws.close(LIVE_CLOSE.unauthenticated, 'auth_timeout');
    }, LIVE_LIMITS.authTimeoutMs);

    const signIn = async (token: string): Promise<void> => {
      let claims;
      try {
        claims = await this.tokens.verify(token);
      } catch {
        if (conn)
          this.connections.close(
            conn,
            LIVE_CLOSE.unauthenticated,
            'invalid_token',
          );
        else ws.close(LIVE_CLOSE.unauthenticated, 'invalid_token');
        return;
      }
      if (ws.readyState !== ws.OPEN) return;
      if (conn) {
        if (claims.sub !== conn.wawuId) {
          this.connections.close(conn, LIVE_CLOSE.wrongPerson, 'wrong_person');
          return;
        }
        this.armExpiry(conn, claims.exp * 1000);
        return;
      }
      clearTimeout(authTimer);
      release();
      conn = {
        ws,
        wawuId: claims.sub,
        expiresAtMs: claims.exp * 1000,
        alive: true,
        expiryTimer: undefined,
      };
      this.armExpiry(conn, conn.expiresAtMs);
      this.connections.add(conn);
      const ready: LiveReadyFrame = {
        type: 'ready',
        wawuId: conn.wawuId,
        cursor: encodeLiveCursor(new Date()),
      };
      ws.send(JSON.stringify(ready));
    };

    // Frames are handled one after another: a token still being checked must
    // not let a later frame through ahead of it.
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw: RawData) => {
      queue = queue.then(async () => {
        const frame = parseFrame(raw);
        if (!frame) {
          if (conn) this.connections.close(conn, 1003, 'bad_frame');
          else ws.close(LIVE_CLOSE.unauthenticated, 'auth_required');
          return;
        }
        if (frame.type === 'auth') return signIn(frame.token);
        if (!conn) {
          ws.close(LIVE_CLOSE.unauthenticated, 'auth_required');
          return;
        }
        ws.send('{"type":"pong"}');
      });
    });
    ws.on('pong', () => {
      if (conn) conn.alive = true;
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      release();
      if (conn) this.connections.remove(conn);
    });
    ws.on('error', (e) => this.logger.debug(`socket error: ${e.message}`));

    const header = req.headers.authorization;
    if (typeof header === 'string' && /^Bearer\s+\S+$/i.test(header)) {
      queue = queue.then(() => signIn(header.replace(/^Bearer\s+/i, '')));
    }
  }

  private armExpiry(conn: LiveConnection, expiresAtMs: number): void {
    clearTimeout(conn.expiryTimer);
    conn.expiresAtMs = expiresAtMs;
    const wait = Math.max(0, expiresAtMs - Date.now());
    conn.expiryTimer = setTimeout(
      () =>
        this.connections.close(
          conn,
          LIVE_CLOSE.unauthenticated,
          'token_expired',
        ),
      Math.min(wait, 2_147_483_647),
    );
  }
}

type ClientFrame = { type: 'auth'; token: string } | { type: 'ping' };

/** The only two frames a client sends. Anything else is not a frame. */
function parseFrame(raw: RawData): ClientFrame | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as Buffer).toString('utf8');
    const v = JSON.parse(text) as { type?: unknown; token?: unknown };
    if (v.type === 'ping') return { type: 'ping' };
    if (
      v.type === 'auth' &&
      typeof v.token === 'string' &&
      v.token.length > 0
    ) {
      return { type: 'auth', token: v.token };
    }
  } catch {
    // not JSON
  }
  return null;
}

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * The address a socket comes from, read the way the Hub's own rate limits read
 * it: behind nginx on loopback, the right-most X-Forwarded-For entry (the
 * address nginx saw); from anywhere else, the peer itself.
 */
function addressOf(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!hubTrustProxy(peer, 0)) return peer;
  const forwarded = req.headers['x-forwarded-for'];
  const list = (
    Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')
  )
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return list.length > 0 ? list[list.length - 1] : peer;
}

/**
 * Gives a request that is not for the live socket back to the HTTP server as
 * the ordinary request it is. Node treats a request with an Upgrade header as
 * the 'upgrade' event's to answer once anything listens for it, and nothing
 * else would: without this such a request (a proxy that forwards the header on
 * every request, an h2c probe) would hang. The request is replayed on the
 * same socket without its Upgrade header, so it gets the answer it gets when
 * no one listens for upgrades.
 */
function handBack(
  server: Server,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    let value = req.rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (lower === 'upgrade') continue;
    if (lower === 'connection') {
      const kept = value
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '' && t.toLowerCase() !== 'upgrade');
      if (kept.length === 0) continue;
      value = kept.join(', ');
    }
    lines.push(`${name}: ${value}`);
  }
  socket.unshift(
    Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), head]),
  );
  server.emit('connection', socket);
}
