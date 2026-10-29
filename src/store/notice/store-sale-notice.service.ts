import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { StoreIntentKind } from '../../../generated/prisma/enums';
import { NoticeFacts } from '../../notice-mail/notice-facts';
import { noticeKey, NoticeMailer } from '../../notice-mail/notice-mailer';
import { NotificationService } from '../../notification/notification.service';
import { creatorShareOfList } from '../store-buy-rules';

/** The facts one store sale's notice is made from. */
export interface SaleNotice {
  kind: StoreIntentKind;
  /** The creator told: a piece's maker, the person tipped, a room's host, the person who answered. */
  creatorWawuId: string;
  /** The buyer (never shown by name; the notice's actor). Null once their account is gone. */
  buyerWawuId: string | null;
  /** The piece, the creator tipped, the room or the question. */
  targetId: string;
  /** A piece's title; unused for the others. */
  title: string;
  /** The store purchase's id: the sale's own id, for the email's key. */
  purchaseId: string;
  /** The LIST price, whole kobo: the notice shows the creator's 85% of it, never what the store charged. */
  listPriceKobo: number;
}

/**
 * Tells a creator of each sale made through a store (STORE-SALE-NOTICE,
 * R-101): a piece, a tip, a community pass, and a paid question when it is
 * answered. It shows the creator's 85% of the list price in naira, the figure
 * the earning records, and says the platform fee came off, as a wallet sale's
 * notice does.
 *
 * Told ONCE per sale: it is written inside the transaction that records the
 * sale's earning (`emitOrThrow` on the caller's client), so "told" and "the
 * earning exists" are one fact. A sale replayed, a purchase posted twice and a
 * webhook that races the app each find the earning (or the purchase) already
 * there and never reach here. It uses the kinds a wallet sale uses where one
 * fits (`sale` for a piece, `tip_received` for a tip) and adds `pass_sold` and
 * `question_answered`; each follows the "Money in" switch.
 */
@Injectable()
export class StoreSaleNoticeService {
  constructor(
    private readonly notifications: NotificationService,
    private readonly mail: NoticeMailer,
    private readonly facts: NoticeFacts,
  ) {}

  /**
   * EMAIL-02: the creator's email for a store sale, held until the sale's
   * transaction commits (the caller wraps it in `NoticeMailer.within`): a
   * piece is `sale_made`, a tip `tip_received`, a community pass `pass_sold`,
   * and an answered question `question_earned` (the creator was told the
   * question arrived by `paid_message_received`; this is the earning, at the
   * moment it arises).
   */
  private email(sale: SaleNotice): void {
    this.mail.later(async () => {
      const [buyerName, paidWhen] = await Promise.all([
        this.facts.nameOf(sale.buyerWawuId),
        this.facts.paidWhen(sale.creatorWawuId, 'store'),
      ]);
      const earnedMinor = creatorShareOfList(sale.listPriceKobo);
      switch (sale.kind) {
        case 'content':
          this.mail.notify(
            sale.creatorWawuId,
            'sale_made',
            {
              itemTitle: sale.title,
              buyerName,
              earnedMinor,
              currency: 'NGN',
              paidWhen,
            },
            noticeKey('sale_made', sale.purchaseId),
          );
          return;
        case 'tip':
          this.mail.notify(
            sale.creatorWawuId,
            'tip_received',
            { earnedMinor, currency: 'NGN', fromName: buyerName, paidWhen },
            noticeKey('tip_received', sale.purchaseId),
          );
          return;
        case 'pass': {
          const communityName = await this.facts.communityName(sale.targetId);
          if (communityName === null) return;
          this.mail.notify(
            sale.creatorWawuId,
            'pass_sold',
            {
              communityName,
              buyerName,
              earnedMinor,
              currency: 'NGN',
              paidWhen,
            },
            noticeKey('pass_sold', sale.purchaseId),
          );
          return;
        }
        case 'question':
          this.mail.notify(
            sale.creatorWawuId,
            'question_earned',
            { fromName: buyerName, earnedMinor, currency: 'NGN', paidWhen },
            noticeKey('question_earned', sale.purchaseId),
          );
          return;
      }
    });
  }

  async told(tx: Prisma.TransactionClient, sale: SaleNotice): Promise<void> {
    // List prices are whole hundreds of naira, so 85% is a whole naira figure.
    this.email(sale);
    const netAmount = creatorShareOfList(sale.listPriceKobo) / 100;
    const actorWawuId = sale.buyerWawuId;
    const userWawuId = sale.creatorWawuId;
    switch (sale.kind) {
      case 'content':
        await this.notifications.emitOrThrow(
          {
            kind: 'sale',
            userWawuId,
            contentTitle: sale.title,
            netAmount,
            about: {
              target: { kind: 'content', id: sale.targetId },
              actorWawuId,
            },
          },
          tx,
        );
        return;
      case 'tip':
        await this.notifications.emitOrThrow(
          {
            kind: 'tip_received',
            userWawuId,
            netAmount,
            about: {
              target: actorWawuId ? { kind: 'profile', id: actorWawuId } : null,
              actorWawuId,
            },
          },
          tx,
        );
        return;
      case 'pass': {
        const room = await tx.community.findUnique({
          where: { id: sale.targetId },
          select: { name: true },
        });
        await this.notifications.emitOrThrow(
          {
            kind: 'pass_sold',
            userWawuId,
            roomName: room?.name ?? 'your room',
            netAmount,
            about: {
              target: { kind: 'community', id: sale.targetId },
              actorWawuId,
            },
          },
          tx,
        );
        return;
      }
      case 'question':
        await this.notifications.emitOrThrow(
          {
            kind: 'question_answered',
            userWawuId,
            netAmount,
            about: {
              target: { kind: 'paid_question', id: sale.targetId },
              actorWawuId,
            },
          },
          tx,
        );
        return;
    }
  }
}
