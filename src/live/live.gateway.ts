import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
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
  private onUpgrade:
    ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly connections: LiveConnections,
    private readonly listener: LiveListener,
    private readonly tokens: LiveTokenVerifier,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter.getHttpServer() as {
      on(event: 'upgrade', cb: LiveGateway['onUpgrade']): void;
    };
    this.onUpgrade = (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== LIVE_LIMITS.path) return;
      if (!this.listener.isUp) {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    };
    server.on('upgrade', this.onUpgrade);
    this.heartbeat = setInterval(() => this.beat(), LIVE_LIMITS.heartbeatMs);
    this.heartbeat.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.heartbeat);
    this.connections.closeAll(LIVE_CLOSE.goingAway, 'shutting down');
    this.wss.close();
  }

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

  private accept(ws: WebSocket, req: IncomingMessage): void {
    let conn: LiveConnection | undefined;
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
