import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { CATEGORY_LABELS } from '../money/history/history-labels';
import { PrismaService } from '../common/prisma/prisma.service';
import { LivePublisher } from '../live/live-publisher.service';
import type { OpenSupportThreadDto } from './dto/support.dto';
import { SUPPORT_WAWU_ID } from './support-account';
import type {
  SupportReferenceKind,
  SupportReferenceView,
  SupportThreadView,
} from './support-view.type';

/** The one answer for a reference that does not exist and one that is not the caller's. */
const NOT_FOUND_MESSAGE = 'We could not find that payment.';

/** What a reference says about itself, once it is known to be the caller's. */
interface ResolvedReference {
  view: SupportReferenceView;
  /** The words of the first message: facts only, nothing promised about the money. */
  line: string;
}

/** Kobo as naira: 200000 is "₦2,000.00". Integers only. */
function naira(kobo: bigint): string {
  const whole = (kobo / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${whole}.${(kobo % 100n).toString().padStart(2, '0')}`;
}

/**
 * Support threads (task SUPPORT-01, DECISIONS R-30). A support thread is the
 * person's free chat with the support account (see support-account.ts), so a
 * staff reply, the unread count, the inbox row and the live update all come
 * from the chat. This service only does what a chat does not: it opens the
 * thread without being asked who the other side is, and it writes the first
 * message, which names the payment the person wants help with, so nobody
 * describes it twice.
 *
 * The reference is checked against the caller before anything is written. A
 * reference that does not exist and one that belongs to someone else answer
 * the same 404, so an id reveals nothing. The message is written as the
 * person (it is theirs) once per reference: its `clientMessageId` is derived
 * from the reference, so a second tap, or two taps at once, reuse the first.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly live: LivePublisher,
  ) {}

  /** POST /support/thread. */
  async openThread(
    me: string,
    dto: OpenSupportThreadDto,
  ): Promise<SupportThreadView> {
    const resolved = dto.reference
      ? await this.resolve(me, dto.reference.kind, dto.reference.id)
      : null;
    const chat = await this.chats.ensureConversation(me, SUPPORT_WAWU_ID);
    if (!resolved) {
      return { chatId: chat.id, reference: null, messageId: null };
    }
    const key = clientKeyOf(resolved.view);
    const earlier = await this.findByKey(chat.id, me, key);
    if (earlier) {
      return {
        chatId: chat.id,
        reference: resolved.view,
        messageId: earlier,
      };
    }
    let messageId: string;
    try {
      const row = await this.prisma.$transaction((tx) =>
        this.chats.writeMessage(tx, me, chat.id, 'text', resolved.line, key),
      );
      messageId = row.id;
      // After the commit, so a listener that hydrates the message finds it.
      await this.live.publish({
        kind: 'chat.message',
        chatId: chat.id,
        messageId,
      });
    } catch (e) {
      // The same reference sent twice at the same moment: the first insert
      // won, and its message is the answer to both.
      if (!isUniqueViolation(e)) throw e;
      const first = await this.findByKey(chat.id, me, key);
      if (!first) throw e;
      messageId = first;
    }
    return { chatId: chat.id, reference: resolved.view, messageId };
  }

  private async findByKey(
    chatId: string,
    me: string,
    key: string,
  ): Promise<string | null> {
    const row = await this.prisma.chatMessage.findUnique({
      where: {
        conversationId_senderWawuId_clientMessageId: {
          conversationId: chatId,
          senderWawuId: me,
          clientMessageId: key,
        },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private resolve(
    me: string,
    kind: SupportReferenceKind,
    id: string,
  ): Promise<ResolvedReference> {
    switch (kind) {
      case 'transaction':
        return this.resolveTransaction(me, id);
      case 'payment':
        return this.resolvePayment(me, id);
      default:
        throw new BadRequestException('That kind of reference is not known.');
    }
  }

  /** A row of the caller's own wallet history (W27). */
  private async resolveTransaction(
    me: string,
    id: string,
  ): Promise<ResolvedReference> {
    const e = await this.prisma.fintavaLedgerEntry.findFirst({
      where: { id, walletKind: 'user', wawuUserId: me },
      select: {
        id: true,
        category: true,
        totalKobo: true,
        linkTitle: true,
        counterpartyName: true,
        customerReference: true,
        fintavaReference: true,
        sessionId: true,
        fintavaTransactionId: true,
        tagapayTransRef: true,
      },
    });
    if (!e) throw new NotFoundException(NOT_FOUND_MESSAGE);
    // The reference W27 shows: the first of these the row has.
    const reference =
      e.customerReference ||
      e.fintavaReference ||
      e.sessionId ||
      e.fintavaTransactionId ||
      e.tagapayTransRef ||
      e.id;
    const what = [
      CATEGORY_LABELS[e.category] ?? 'Transaction',
      e.linkTitle?.trim() || e.counterpartyName?.trim() || null,
    ]
      .filter(Boolean)
      .join(' · ');
    return resolved('transaction', e.id, reference, what, e.totalKobo);
  }

  /** A payment the caller made (an unlock, a tip, a ticket). */
  private async resolvePayment(
    me: string,
    id: string,
  ): Promise<ResolvedReference> {
    const p = await this.prisma.walletPayment.findFirst({
      where: { id, payerWawuUserId: me },
      select: {
        id: true,
        title: true,
        totalKobo: true,
        customerReference: true,
      },
    });
    if (!p) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return resolved(
      'payment',
      p.id,
      p.customerReference,
      `Payment · ${p.title.trim()}`,
      p.totalKobo,
    );
  }
}

function resolved(
  kind: SupportReferenceKind,
  id: string,
  reference: string,
  what: string,
  totalKobo: bigint,
): ResolvedReference {
  return {
    view: { kind, id, reference },
    line: `Help with a payment: ${what} · ${naira(totalKobo)} · Reference ${reference}`,
  };
}

/** One message per reference: `sref-t-<id>` or `sref-p-<id>`. */
function clientKeyOf(view: SupportReferenceView): string {
  return `sref-${view.kind === 'transaction' ? 't' : 'p'}-${view.id}`;
}
