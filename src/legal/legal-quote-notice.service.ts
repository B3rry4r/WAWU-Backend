import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AdminActor } from '../common/audit/admin-ops-audit.service';
import { NotificationService } from '../notification/notification.service';
import { LegalAssistantAllowance } from '../legal-intake/assistant/legal-assistant-allowance';
import { ASSISTANT_CHANNEL } from '../legal-intake/assistant/legal-assistant.service';
import { LivePublisher } from '../live/live-publisher.service';

/** "45000" as "45,000". */
const withCommas = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** What the consultant's line in the chat says (S21): true of what the person finds when they open the request. */
export const quoteLine = (amountNaira: number) =>
  `I have sent you a quote of ₦${withCommas(amountNaira)}. Open your request to read the agreement and sign it.`;

/**
 * After a consultant prices a conversation's matter (R2-LEGAL2, CHECK-3 H-1):
 * the quote arrives as the board draws it ("Adaora sends a quote in the
 * chat", S20 to S21), and the person is told with a notification that opens
 * the matter. Before this the Hub wrote neither, so a person who had left the
 * matter never learned a quote was waiting.
 *
 * Only for a matter that began in the app's assistant conversation: the web's
 * own request flow keeps behaving as it does (nothing the web calls changes).
 * Never throws: the quote is already saved when this runs.
 */
@Injectable()
export class LegalQuoteNoticeService {
  private readonly logger = new Logger(LegalQuoteNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly allowance: LegalAssistantAllowance,
    private readonly live: LivePublisher,
  ) {}

  async quoteReady(admin: AdminActor, requestId: string): Promise<void> {
    try {
      const request = await this.prisma.legalRequest.findUnique({
        where: { id: requestId },
      });
      if (!request || request.status !== 'quoted') return;
      if (request.quoteAmount === null || request.quoteAmount < 1) return;
      const conversation = await this.prisma.legalIntake.findFirst({
        where: { legalRequestId: requestId, channel: ASSISTANT_CHANNEL },
        select: { id: true },
      });
      if (!conversation) return;
      const written = await this.allowance.writeAsConsultant(
        request.wawuUserId,
        (tx, createdAt) =>
          tx.legalChatMessage.create({
            data: {
              legalRequestId: requestId,
              authorRole: 'consultant',
              authorAdminId: admin.id,
              body: quoteLine(request.quoteAmount as number),
              createdAt,
            },
          }),
      );
      await this.live.publish({
        kind: 'legal.thread',
        legalRequestId: requestId,
        messageId: written.id,
      });
      await this.notifications.emit({
        kind: 'legal_quote_ready',
        userWawuId: request.wawuUserId,
        requestId,
        serviceName: request.serviceName,
      });
    } catch (error) {
      this.logger.error(
        `Could not tell the client about the quote on ${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
