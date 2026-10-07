import { randomUUID } from 'crypto';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Client } from 'pg';
import { LiveConnections } from './live-connections.service';
import { LiveDispatcher } from './live-dispatcher.service';
import { LIVE_CLOSE, LIVE_LIMITS } from './live-limits';
import { LivePublisher } from './live-publisher.service';
import {
  LIVE_CHANNEL,
  type LiveProbe,
  type LiveSignal,
} from './live-signal.type';

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const DEAF =
  'LISTEN did not receive its own probe; DATABASE_URL must be a direct connection, not a transaction-mode pool';

/**
 * This instance's feed of signals: one dedicated Postgres connection that
 * `LISTEN`s on the live channel. It has to be its own connection (the Prisma
 * pool hands connections out per query, and a listener must stay on one), and
 * it has to reach Postgres directly, not through a transaction-mode pooler,
 * which does not carry `LISTEN`. DigitalOcean's managed Postgres serves the
 * direct port (25060, which deploy/README.md uses) and a separate pool port;
 * the Hub uses the direct one.
 *
 * The feed proves it can hear. When it connects, and every
 * LIVE_LIMITS.probeEveryMs after, it sends itself a probe through the normal
 * publish path and requires it back within LIVE_LIMITS.probeTimeoutMs. A
 * pooler or a half-open connection accepts `LISTEN` and then delivers
 * nothing, and no error ever says so; the probe is how that is noticed.
 *
 * When the feed drops or goes deaf, every socket on this instance is closed
 * with 4503 and none is accepted until the feed is back. A client that
 * reconnects then catches up from its cursor, so a signal missed meanwhile is
 * never a message lost. The probe goes to no client.
 */
@Injectable()
export class LiveListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveListener.name);
  /** Read once: a later change to the environment must not move the feed. */
  private readonly url = process.env.DATABASE_URL;
  private client: Client | undefined;
  private up = false;
  private stopped = false;
  private retryMs = RECONNECT_FIRST_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private readonly waiting = new Map<string, () => void>();

  constructor(
    private readonly connections: LiveConnections,
    private readonly dispatcher: LiveDispatcher,
    private readonly publisher: LivePublisher,
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
    clearInterval(this.probeTimer);
    const client = this.client;
    this.client = undefined;
    this.up = false;
    if (client) await client.end().catch(() => undefined);
  }

  /**
   * Sends a probe and waits for it. When it does not come back the feed is
   * treated as lost. Runs on a timer, and is public so a test can run it now.
   */
  async checkNow(): Promise<void> {
    const client = this.client;
    if (!client || !this.up) return;
    if (!(await this.probe())) this.lose(client, DEAF, true);
  }

  private async probe(): Promise<boolean> {
    const probe: LiveProbe = { kind: 'probe', id: randomUUID() };
    const heard = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(probe.id);
        resolve(false);
      }, LIVE_LIMITS.probeTimeoutMs);
      this.waiting.set(probe.id, () => {
        clearTimeout(timer);
        this.waiting.delete(probe.id);
        resolve(true);
      });
    });
    try {
      await this.publisher.send(probe);
    } catch (e) {
      this.logger.warn(`Could not send the feed's probe: ${String(e)}`);
      return false;
    }
    return heard;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({
      connectionString: this.url,
      keepAlive: true,
    });
    client.on('notification', (msg) => {
      if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
      const signal = parseSignal(msg.payload);
      if (!signal) return;
      if (signal.kind === 'probe') {
        this.waiting.get(signal.id)?.();
        return;
      }
      void this.dispatcher.handle(signal);
    });
    // `error` and `end` both fire when the connection goes; the first one
    // that finds this client still current does the work.
    client.on('error', (e) => this.lose(client, e.message, false));
    client.on('end', () => this.lose(client, 'connection ended', false));
    this.client = client;
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      if (this.stopped || this.client !== client) {
        await client.end().catch(() => undefined);
        return;
      }
      // Not up until a probe has come back: LISTEN being accepted says
      // nothing about whether anything will be delivered.
      const heard = await this.probe();
      if (this.stopped || this.client !== client) return;
      if (!heard) {
        this.lose(client, DEAF, true);
        return;
      }
      this.up = true;
      this.retryMs = RECONNECT_FIRST_MS;
      clearInterval(this.probeTimer);
      this.probeTimer = setInterval(
        () => void this.checkNow(),
        LIVE_LIMITS.probeEveryMs,
      );
      this.probeTimer.unref();
      this.logger.log('Live feed listening');
    } catch (e) {
      this.lose(client, e instanceof Error ? e.message : String(e), false);
    }
  }

  private lose(client: Client, why: string, asError: boolean): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.up = false;
    clearInterval(this.probeTimer);
    if (asError) this.logger.error(`Live feed down: ${why}`);
    else this.logger.warn(`Live feed lost (${why}); closing sockets`);
    this.connections.closeAll(LIVE_CLOSE.resync, 'resync');
    void client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }
}

function parseSignal(payload: string): LiveSignal | LiveProbe | null {
  try {
    const v = JSON.parse(payload) as Record<string, unknown>;
    const s = (k: string): string => {
      const x = v[k];
      return typeof x === 'string' ? x : '';
    };
    if (v.kind === 'probe' && s('id')) return { kind: 'probe', id: s('id') };
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
