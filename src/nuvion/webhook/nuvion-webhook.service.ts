import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  jsonWithoutNulChars,
  readNuvionDelivery,
} from './nuvion-webhook-event';
import type { NuvionWebhookAck } from './nuvion-webhook-view.type';

/**
 * Stores a signed Nuvion delivery once, and nothing else (task NUV-01).
 *
 * Nuvion wants a 2xx fast ("Respond with 2xx immediately and process the
 * event asynchronously", webhooks__overview.md) and drops a delivery it
 * could not hand over within 15 minutes, so the only work here is one
 * insert; the 2xx goes back only once it is committed. The handlers
 * (src/nuvion/handlers/, run by NuvionWebhookDispatcher) read the rows.
 * No money moves and no balance changes here.
 *
 * Exactly once: the insert is `ON CONFLICT DO NOTHING` against two unique
 * keys, the event id and the signed (timestamp, body) pair. A retry, a
 * replay, or two copies at once land on the same row; one is written and
 * every other copy answers `duplicate`. No read before the write.
 */
@Injectable()
export class NuvionWebhookStore {
  private readonly logger = new Logger(NuvionWebhookStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    eventId: string;
    signedAt: string;
    rawBody: Buffer;
    body: unknown;
  }): Promise<NuvionWebhookAck> {
    const delivery = readNuvionDelivery(input.body);
    // Only a documented name reaches a log line.
    const label =
      delivery.status === 'unrecognised' ? 'unrecognised event' : delivery.event;
    let written: number;
    try {
      const result = await this.prisma.nuvionWebhookEvent.createMany({
        data: [
          {
            eventId: input.eventId,
            event: delivery.event,
            resourceId: delivery.resourceId,
            entityId: delivery.entityId,
            signedAt: input.signedAt.slice(0, 64),
            bodySha256: createHash('sha256').update(input.rawBody).digest('hex'),
            rawBody: new Uint8Array(input.rawBody),
            payload:
              input.body === null || input.body === undefined
                ? Prisma.JsonNull
                : (jsonWithoutNulChars(input.body) as Prisma.InputJsonValue),
            processingStatus: delivery.status,
          },
        ],
        skipDuplicates: true,
      });
      written = result.count;
    } catch (e) {
      // Prisma's message can quote the payload: the error's name and code
      // only, and a plain 503 so Nuvion sends it again.
      const code =
        typeof (e as { code?: unknown }).code === 'string'
          ? ` ${(e as { code: string }).code}`
          : '';
      this.logger.error(
        `nuvion webhook ${label}: not stored (${(e as Error).name ?? 'Error'}${code})`,
      );
      throw new ServiceUnavailableException(
        'The webhook could not be recorded. Please send it again.',
      );
    }
    const outcome = written === 1 ? 'recorded' : 'duplicate';
    this.logger.log(`nuvion webhook ${label}: ${outcome}`);
    return { outcome, event: delivery.event === '' ? null : delivery.event };
  }
}
