import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Client } from 'pg';
import { LiveConnections } from './live-connections.service';
import { LiveDispatcher } from './live-dispatcher.service';
import { LIVE_CLOSE } from './live-limits';
import { LIVE_CHANNEL, type LiveSignal } from './live-signal.type';

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * This instance's feed of signals: one dedicated Postgres connection that
 * `LISTEN`s on the live channel. It has to be its own connection (the Prisma
 * pool hands connections out per query, and a listener must stay on one), and
 * it has to reach Postgres directly, not through a transaction-mode pooler,
 * which does not carry `LISTEN`. DigitalOcean's managed Postgres serves the
 * direct port (25060, which deploy/README.md uses) and a separate pool port;
 * the Hub uses the direct one.
 *
 * When the feed drops, every socket on this instance is closed with 4503 and
 * none is accepted until the feed is back. A client that reconnects then
 * catches up from its cursor, so a signal missed while the feed was down is
 * never a message lost.
 */
@Injectable()
export class LiveListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveListener.name);
  private client: Client | undefined;
  private up = false;
  private stopped = false;
  private retryMs = RECONNECT_FIRST_MS;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connections: LiveConnections,
    private readonly dispatcher: LiveDispatcher,
  ) {}

  /** True while signals are arriving. Sockets are accepted only then. */
  get isUp(): boolean {
    return this.up;
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    this.up = false;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on('notification', (msg) => {
      if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
      const signal = parseSignal(msg.payload);
      if (signal) void this.dispatcher.handle(signal);
    });
    // `error` and `end` both fire when the connection goes; the first one
    // that finds this client still current does the work.
    const lost = (why: string) => {
      if (this.client !== client) return;
      this.client = undefined;
      this.up = false;
      this.logger.warn(`Live feed lost (${why}); closing sockets`);
      this.connections.closeAll(LIVE_CLOSE.resync, 'resync');
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', (e) => lost(e.message));
    client.on('end', () => lost('connection ended'));
    this.client = client;
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      if (this.stopped || this.client !== client) {
        await client.end().catch(() => undefined);
        return;
      }
      this.up = true;
      this.retryMs = RECONNECT_FIRST_MS;
      this.logger.log('Live feed listening');
    } catch (e) {
      lost(e instanceof Error ? e.message : String(e));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }
}

function parseSignal(payload: string): LiveSignal | null {
  try {
    const v = JSON.parse(payload) as Record<string, unknown>;
    const s = (k: string): string => {
      const x = v[k];
      return typeof x === 'string' ? x : '';
    };
    if (v.kind === 'chat.message' && s('chatId') && s('messageId')) {
      return {
        kind: 'chat.message',
        chatId: s('chatId'),
        messageId: s('messageId'),
      };
    }
    if (v.kind === 'chat.read' && s('chatId') && s('readerWawuId')) {
      return {
        kind: 'chat.read',
        chatId: s('chatId'),
        readerWawuId: s('readerWawuId'),
      };
    }
    if (v.kind === 'community.message' && s('communityId') && s('messageId')) {
      return {
        kind: 'community.message',
        communityId: s('communityId'),
        messageId: s('messageId'),
      };
    }
  } catch {
    // not ours
  }
  return null;
}
