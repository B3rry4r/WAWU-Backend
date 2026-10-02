import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FINTAVA_WEBHOOK_EVENTS,
  readFintavaWebhook,
} from './fintava-webhook-event';
import type { FintavaWebhookAck } from './fintava-webhook-view.type';

/**
 * Records a signed Fintava delivery once, and nothing else (task MONEY-07).
 *
 * Fintava wants a 200 fast and retries anything else (live: every 3 minutes
 * for 4 tries, then hourly for 72 hours), so the only work here is one
 * insert. No money moves and no balance changes: each known event is
 * stored `pending` for the task that consumes it (FINTAVA_WEBHOOK_EVENTS:
 * the ledger, MONEY-10; the pending sweep, MONEY-08; money-in
 * notifications, WALLET-10; cards, WALLET-22). An event nobody documents is
 * stored `unrecognised`.
 *
 * Exactly once: the insert is `ON CONFLICT DO NOTHING` against the unique
 * key (event, reference, fintavaStatus). A retry, a replayed capture or two
 * copies arriving together all race for the same key; one row is written
 * and every other copy answers `duplicate`. There is no read before the
 * write, so there is no window between a check and an insert.
 */
@Injectable()
export class FintavaWebhookService {
  private readonly logger = new Logger(FintavaWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(rawBody: Buffer, body: unknown): Promise<FintavaWebhookAck> {
    const delivery = readFintavaWebhook(body, rawBody);
    // Only a name we document reaches a log line; anything else is just
    // "unrecognised", so a log never echoes what a delivery carried.
    const label = delivery.known ? delivery.event : 'unrecognised event';

    let written: number;
    try {
      const result = await this.prisma.fintavaWebhookEvent.createMany({
        data: [
          {
            event: delivery.event,
            eventRaw: delivery.eventRaw,
            reference: delivery.reference,
            referenceField: delivery.referenceField,
            fintavaStatus: delivery.fintavaStatus,
            dataReference: delivery.dataReference,
            dataCustomerReference: delivery.dataCustomerReference,
            rawBody: rawBody.toString('utf8'),
            payload:
              body === null || body === undefined
                ? Prisma.JsonNull
                : (body as Prisma.InputJsonValue),
            processingStatus: delivery.known ? 'pending' : 'unrecognised',
          },
        ],
        skipDuplicates: true,
      });
      written = result.count;
    } catch (e) {
      // Prisma's message can quote the values it was given (the payload),
      // so only the error's name and code are logged, and a plain 503 goes
      // back: Fintava sends the delivery again later.
      const code =
        typeof (e as { code?: unknown }).code === 'string'
          ? ` ${(e as { code: string }).code}`
          : '';
      this.logger.error(
        `fintava webhook ${label}: not stored (${(e as Error).name ?? 'Error'}${code})`,
      );
      throw new ServiceUnavailableException(
        'The webhook could not be recorded. Please send it again.',
      );
    }

    const outcome = written === 1 ? 'recorded' : 'duplicate';
    const consumers = delivery.known
      ? FINTAVA_WEBHOOK_EVENTS[delivery.event].consumers.join(', ')
      : 'review';
    this.logger.log(
      `fintava webhook ${label}: ${outcome} (keyed on ${delivery.referenceField}; for ${consumers})`,
    );
    return { outcome, event: delivery.event === '' ? null : delivery.event };
  }
}
