import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { LIVE_CLOSE, LIVE_LIMITS } from './live-limits';

/** One signed-in socket. */
export interface LiveConnection {
  ws: WebSocket;
  wawuId: string;
  /** The token's `exp`, in milliseconds. */
  expiresAtMs: number;
  /** False from one heartbeat ping until the answer comes. */
  alive: boolean;
  expiryTimer: NodeJS.Timeout | undefined;
}

/**
 * Who is connected to THIS instance. Nothing here is shared between
 * instances: each one holds its own sockets and gets every signal through the
 * Postgres channel (LiveListener).
 */
@Injectable()
export class LiveConnections {
  private readonly logger = new Logger(LiveConnections.name);
  private readonly byUser = new Map<string, Set<LiveConnection>>();

  /** Registers a signed-in socket, closing the person's oldest if they hold too many. */
  add(conn: LiveConnection): void {
    let set = this.byUser.get(conn.wawuId);
    if (!set) {
      set = new Set();
      this.byUser.set(conn.wawuId, set);
    }
    set.add(conn);
    while (set.size > LIVE_LIMITS.socketsPerUser) {
      const oldest = set.values().next().value as LiveConnection;
      this.close(oldest, LIVE_CLOSE.replaced, 'replaced');
    }
  }

  remove(conn: LiveConnection): void {
    clearTimeout(conn.expiryTimer);
    const set = this.byUser.get(conn.wawuId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byUser.delete(conn.wawuId);
  }

  /** Everyone with at least one socket here. */
  userIds(): string[] {
    return [...this.byUser.keys()];
  }

  has(wawuId: string): boolean {
    return this.byUser.has(wawuId);
  }

  get size(): number {
    let n = 0;
    for (const set of this.byUser.values()) n += set.size;
    return n;
  }

  all(): LiveConnection[] {
    return [...this.byUser.values()].flatMap((set) => [...set]);
  }

  /** Sends one JSON frame to every socket this person has here. */
  send(wawuId: string, frame: object): void {
    const set = this.byUser.get(wawuId);
    if (!set) return;
    const text = JSON.stringify(frame);
    for (const conn of set) {
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      conn.ws.send(text, (err) => {
        if (err) this.logger.debug(`send failed: ${err.message}`);
      });
    }
  }

  close(conn: LiveConnection, code: number, reason: string): void {
    this.remove(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }

  closeAll(code: number, reason: string): void {
    for (const conn of this.all()) this.close(conn, code, reason);
  }
}
