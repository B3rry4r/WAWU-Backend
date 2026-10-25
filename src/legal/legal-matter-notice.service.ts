import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

/** The channel of a matter that began in the app's assistant (`ASSISTANT_CHANNEL` in legal-assistant.service.ts; not imported: that file imports the chat service, which imports this one). */
const ASSISTANT_CHANNEL = 'assistant';

/**
 * The two steps of a legal matter that came before the quote notice and had
 * none (R2-MONEY2, CHECK-3 money third pass H-01): a consultant joined the
 * conversation, and the consultation was paid for and booked. Each writes one
 * notification-list row for the client that opens the matter. Neither is a
 * push (`PUSH_RULE` holds them, G-265).
 *
 * Only for a matter that began in the app's assistant conversation, as
 * `LegalQuoteNoticeService`: the web's own request flow behaves as before.
 * Never throws: what happened is already saved when this runs.
 */
@Injectable()
export class LegalMatterNoticeService {
  private readonly logger = new Logger(LegalMatterNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional so a module that mounts a legal service without the (global) notification module still boots; the Hub always has it.
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  consultantJoined(requestId: string): Promise<void> {
    return this.tell('legal_consultant_joined', requestId);
  }

  consultationBooked(requestId: string): Promise<void> {
    return this.tell('legal_consultation_booked', requestId);
  }

  private async tell(
    kind: 'legal_consultant_joined' | 'legal_consultation_booked',
    requestId: string,
  ): Promise<void> {
    try {
      const request = await this.prisma.legalRequest.findUnique({
        where: { id: requestId },
        select: { wawuUserId: true, serviceName: true },
      });
      if (!request || !this.notifications) return;
      const conversation = await this.prisma.legalIntake.findFirst({
        where: { legalRequestId: requestId, channel: ASSISTANT_CHANNEL },
        select: { id: true },
      });
      if (!conversation) return;
      await this.notifications.emit({
        kind,
        userWawuId: request.wawuUserId,
        requestId,
        serviceName: request.serviceName,
      });
    } catch (error) {
      this.logger.error(
        `Could not tell the client (${kind}) on ${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
