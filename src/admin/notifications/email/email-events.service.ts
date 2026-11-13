import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Prisma } from '../../../../generated/prisma/client';
import {
  DELIVERY_RANK,
  parseResendEvent,
  type Delivery,
} from './email-webhook';

export interface EmailEventAck {
  received: true;
  /** `stored`, `duplicate` (the same svix-id came twice) or `ignored` (no readable event). */
  result: 'stored' | 'duplicate' | 'ignored';
}

/**
 * What one Resend delivery changes (EMAIL-03). Every event is stored once
 * (the svix-id is unique, so a repeat answers 200 and changes nothing). A
 * recipient the Hub sent to is found by the provider's mail id and takes the
 * result if it is stronger than the one it has. A permanent bounce and a spam
 * complaint also put the address on the suppression list, whether or not any
 * campaign sent to it (WAWU ID's sign-in codes share the same Resend team).
 */
@Injectable()
export class EmailEventsService {
  private readonly logger = new Logger(EmailEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(svixId: string, body: unknown): Promise<EmailEventAck> {
    const now = new Date();
    const event = parseResendEvent(body, now);
    if (!event) return { received: true, result: 'ignored' };
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.emailEvent.create({
          data: {
            svixId,
            type: event.type,
            providerId: event.providerId,
            email: event.email,
            at: event.at,
            payload: body as Prisma.InputJsonValue,
          },
        });
        if (event.providerId && event.delivery) {
          const weaker = (Object.keys(DELIVERY_RANK) as Delivery[]).filter(
            (d) => DELIVERY_RANK[d] < DELIVERY_RANK[event.delivery as Delivery],
          );
          await tx.emailRecipient.updateMany({
            where: {
              providerId: event.providerId,
              OR: [{ delivery: null }, { delivery: { in: weaker } }],
            },
            data: {
              delivery: event.delivery,
              deliveryAt: event.at,
              deliveryNote: event.note,
            },
          });
        }
        if (event.email && (event.permanentBounce || event.complaint)) {
          const reason = event.complaint ? 'complained' : 'bounced';
          await tx.emailSuppression.upsert({
            where: { email: event.email },
            create: { email: event.email, reason },
            update: {},
          });
          // A dead address or a spam complaint outranks an earlier unsubscribe
          // (a Voices email is skipped for these two reasons); a complaint also
          // outranks an earlier bounce.
          await tx.emailSuppression.updateMany({
            where: {
              email: event.email,
              reason: {
                in: event.complaint
                  ? ['unsubscribed', 'bounced']
                  : ['unsubscribed'],
              },
            },
            data: { reason },
          });
        }
      });
    } catch (e) {
      if (
        typeof e === 'object' &&
        e !== null &&
        (e as { code?: unknown }).code === 'P2002'
      ) {
        return { received: true, result: 'duplicate' };
      }
      this.logger.error(
        `resend event ${svixId} not stored: ${e instanceof Error ? e.message : 'error'}`,
      );
      throw e;
    }
    return { received: true, result: 'stored' };
  }
}
