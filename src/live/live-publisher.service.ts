import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { LIVE_CHANNEL, type LiveSignal } from './live-signal.type';

/**
 * Tells every Hub instance that something changed (task INBOX-02), through
 * Postgres `NOTIFY`. Called by the service that wrote the row, after its
 * transaction has committed.
 *
 * It never throws. A message is already stored when this runs, and a failed
 * signal must not turn a sent message into an error: the people it was for
 * get it from the catch-up the next time their app connects or returns to
 * the foreground.
 */
@Injectable()
export class LivePublisher {
  private readonly logger = new Logger(LivePublisher.name);

  constructor(private readonly prisma: PrismaService) {}

  async publish(signal: LiveSignal): Promise<void> {
    try {
      await this.prisma
        .$queryRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${JSON.stringify(signal)})`;
    } catch (e) {
      this.logger.warn(`Could not signal ${signal.kind}: ${String(e)}`);
    }
  }
}
