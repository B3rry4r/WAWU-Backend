import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChatService } from '../chat/chat.service';
import type { ChatMessage } from '../chat/chat-view.type';
import { PrismaService } from '../common/prisma/prisma.service';
import { LivePublisher } from '../live/live-publisher.service';
import type { OpenWallet } from '../money/gate/wallet-gate';
import type { IdempotencyScope } from '../money/payments/idempotency';
import type { TransferView } from '../money/money-view.type';
import { WawuTransferDto } from '../money/dto/money-request.dto';
import { WalletTransferService } from '../money/transfers/wallet-transfer.service';
import {
  MONEY_REQUEST_PAY_ROUTE,
  REQUEST_BEING_PAID_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
  REQUEST_NOT_YOURS_CANCEL_MESSAGE,
  REQUEST_NOT_YOURS_DECLINE_MESSAGE,
  requestNotPendingMessage,
} from './money-request.constants';
import type {
  CreateMoneyRequestDto,
  PayMoneyRequestDto,
} from './dto/money-request.dto';
import {
  MONEY_REQUEST_MESSAGE_KIND,
  type MoneyRequestRow,
  type MoneyRequestView,
  toMoneyRequestView,
} from './money-request-view.type';

/** How many in-flight payments one sweep looks at. */
const SWEEP_PAGE = 100;

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Money requests in chat (task INBOX-15, R-13): one person asks the other in
 * a chat for an amount; the other pays it or declines it, once.
 *
 * - **Written into the chat.** A request is a chat message (kind
 *   `money_request`) with the request beside it, so it sits in the
 *   conversation and the inbox like any bubble, and both people get it live.
 * - **Paid once.** Paying is a send to a WAWU user through the wallet send
 *   (WALLET-07): its Idempotency-Key, its PIN, its fee quote (R-10), its
 *   limits, the provider's balance. The request is tied to that send INSIDE
 *   the send's claim transaction (`transferId`, set only while the request is
 *   pending and unpaid), so two taps with two keys can claim only one send,
 *   a repeat of one key is answered with the first result, and a decline
 *   racing a payment has exactly one winner (both are one conditional
 *   update). A send that has not been confirmed leaves the request `paying`
 *   until the provider's answer settles it (`settleOne`: after the send, on
 *   a read, and in the sweep): completed makes it `paid`; failed or reversed
 *   frees it to be paid again, since nothing moved.
 * - **Nothing is held across a call.** The claim is one short transaction;
 *   the provider is called holding no row, connection or lock.
 */
@Injectable()
export class MoneyRequestService implements OnModuleInit {
  private readonly logger = new Logger(MoneyRequestService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly live: LivePublisher,
    private readonly transfers: WalletTransferService,
  ) {}

  onModuleInit(): void {
    // A pay request that died mid-send is answered from its send, as a plain send's is.
    this.transfers.answerStaleKeysFromSend(MONEY_REQUEST_PAY_ROUTE);
  }

  // ── asking ───────────────────────────────────────────────────────────────

  /** POST /chats/:chatId/money-requests (I16). */
  async create(
    me: string,
    chatId: string,
    dto: CreateMoneyRequestDto,
  ): Promise<ChatMessage> {
    const other = await this.chats.otherInChat(me, chatId, true);
    const memo = dto.memo?.trim() ? dto.memo.trim() : null;

    if (dto.clientRequestId !== undefined) {
      const earlier = await this.findByClientId(
        chatId,
        me,
        dto.clientRequestId,
      );
      if (earlier) return this.messageOf(me, earlier);
    }

    let request: MoneyRequestRow;
    let messageId: string;
    try {
      const made = await this.prisma.$transaction(async (tx) => {
        const message = await this.chats.writeMessage(
          tx,
          me,
          chatId,
          MONEY_REQUEST_MESSAGE_KIND,
          memo,
        );
        const row = await tx.moneyRequest.create({
          data: {
            conversationId: chatId,
            requesterWawuId: me,
            payerWawuId: other,
            amountKobo: BigInt(dto.amountKobo),
            memo,
            messageId: message.id,
            clientRequestId: dto.clientRequestId ?? null,
          },
        });
        return { row, messageId: message.id };
      });
      request = made.row;
      messageId = made.messageId;
      // After the commit, so a listener that hydrates the message finds it.
      await this.live.publish({ kind: 'chat.message', chatId, messageId });
    } catch (e) {
      // The same clientRequestId sent twice at the same moment: the first
      // insert won, and its request is the answer to both.
      if (!isUniqueViolation(e) || dto.clientRequestId === undefined) throw e;
      const earlier = await this.findByClientId(
        chatId,
        me,
        dto.clientRequestId,
      );
      if (!earlier) throw e;
      return this.messageOf(me, earlier);
    }
    return this.messageOf(me, request);
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** GET /chats/:chatId/money-requests/:requestId. */
  async get(
    me: string,
    chatId: string,
    requestId: string,
  ): Promise<MoneyRequestView> {
    await this.settleOne(requestId);
    const row = await this.mine(me, chatId, requestId);
    return toMoneyRequestView(row, me);
  }

  // ── answering ────────────────────────────────────────────────────────────

  /** POST .../decline: the person who was asked says no, once. */
  decline(
    me: string,
    chatId: string,
    requestId: string,
  ): Promise<MoneyRequestView> {
    return this.close(me, chatId, requestId, 'declined');
  }

  /** POST .../cancel: the person who asked takes it back, once. */
  cancel(
    me: string,
    chatId: string,
    requestId: string,
  ): Promise<MoneyRequestView> {
    return this.close(me, chatId, requestId, 'cancelled');
  }

  private async close(
    me: string,
    chatId: string,
    requestId: string,
    to: 'declined' | 'cancelled',
  ): Promise<MoneyRequestView> {
    const row = await this.mine(me, chatId, requestId);
    const allowed =
      to === 'declined' ? row.payerWawuId === me : row.requesterWawuId === me;
    if (!allowed) {
      throw new ForbiddenException({
        message:
          to === 'declined'
            ? REQUEST_NOT_YOURS_DECLINE_MESSAGE
            : REQUEST_NOT_YOURS_CANCEL_MESSAGE,
        reason: { code: 'money_request_not_yours' },
      });
    }
    // One conditional update: of a decline, a cancel and a payment's claim
    // (which sets transferId) racing for one request, exactly one wins.
    const { count } = await this.prisma.moneyRequest.updateMany({
      where: { id: requestId, status: 'pending', transferId: null },
      data: { status: to, changedAt: new Date() },
    });
    const now = await this.mine(me, chatId, requestId);
    if (count === 1) {
      await this.live.publish({
        kind: 'money_request.updated',
        chatId,
        requestId,
      });
    } else if (now.status !== to) {
      // Another answer got there first. The same answer again is not an error.
      throw this.notActionable(now);
    }
    return toMoneyRequestView(now, me);
  }

  // ── paying ───────────────────────────────────────────────────────────────

  /**
   * POST .../pay: a send to the requester for the requested amount, with the
   * wallet send's fee on top. Answers what a send answers (the receipt):
   * completed, pending (not confirmed yet: do not pay again, the request
   * shows `paying`) or failed. The guards before the PIN have already
   * refused what could not succeed; the claim below is the one that decides.
   */
  async pay(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    chatId: string,
    requestId: string,
    dto: PayMoneyRequestDto,
  ): Promise<TransferView> {
    const payer = wallet.wawuUserId;
    const row = await this.mine(payer, chatId, requestId);
    if (row.payerWawuId !== payer) {
      throw new ForbiddenException({
        message: 'Only the person who was asked can pay this request.',
        reason: { code: 'money_request_not_yours' },
      });
    }
    const send = Object.assign(new WawuTransferDto(), {
      recipientWawuUserId: row.requesterWawuId,
      amountKobo: Number(row.amountKobo),
      expectedTotalKobo: dto.expectedTotalKobo,
      quoteToken: dto.quoteToken,
      note: row.memo ?? undefined,
    });
    try {
      return await this.transfers.send(
        wallet,
        send,
        scope,
        async (tx, transferId) => {
          const { count } = await tx.moneyRequest.updateMany({
            where: {
              id: requestId,
              payerWawuId: payer,
              status: 'pending',
              transferId: null,
            },
            data: { transferId },
          });
          if (count !== 1) {
            // Someone else's payment, a decline or a cancel got there first.
            // Throwing rolls this whole claim back: nothing is sent.
            const now = await tx.moneyRequest.findUnique({
              where: { id: requestId },
              select: { status: true, transferId: true },
            });
            throw this.notActionable(now ?? { status: 'pending', transferId });
          }
        },
      );
    } finally {
      // The send may already be settled (completed, or failed with nothing
      // moved): bring the request to match before the answer goes out. A
      // pending send is left for the sweep.
      await this.settleOne(requestId);
    }
  }

  // ── settling a request from its send ─────────────────────────────────────

  /**
   * Brings one request in line with the send paying it: a completed send
   * makes it `paid` (once), a failed or reversed one frees it to be paid
   * again, a pending one changes nothing. Reads our own records only and is
   * safe to run any number of times, from any number of servers.
   */
  async settleOne(requestId: string): Promise<void> {
    try {
      const r = await this.prisma.moneyRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          status: true,
          transferId: true,
          conversationId: true,
          requesterWawuId: true,
        },
      });
      if (!r || r.status !== 'pending' || r.transferId === null) return;
      const t = await this.prisma.walletTransfer.findUnique({
        where: { id: r.transferId },
        select: { status: true },
      });
      if (!t) return;
      if (t.status === 'completed') {
        const { count } = await this.prisma.moneyRequest.updateMany({
          where: { id: r.id, status: 'pending', transferId: r.transferId },
          data: { status: 'paid', changedAt: new Date() },
        });
        if (count === 1) {
          await this.live.publish({
            kind: 'money_request.updated',
            chatId: r.conversationId,
            requestId: r.id,
          });
        }
      } else if (t.status === 'failed' || t.status === 'reversed') {
        const { count } = await this.prisma.moneyRequest.updateMany({
          where: { id: r.id, status: 'pending', transferId: r.transferId },
          data: { transferId: null },
        });
        // Freed for the asker to pay again, unless the asker has been erased
        // since: nobody is left to be paid, so it closes (round 2). Checked
        // AFTER the freeing, so a purge that started in between has either
        // been seen here or finds the freed request in its own sweep.
        if (count === 1) {
          await this.closeIfAskerErased(
            r.id,
            r.conversationId,
            r.requesterWawuId,
          );
        }
      }
    } catch (e) {
      this.logger.error(
        `money request ${requestId}: could not settle it from its send (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  // ── a request whose asker was erased (round 2) ───────────────────────────

  /**
   * A request that has just been freed (its send failed) closes when its asker
   * is being or has been erased (`eraseAskerRequests` leaves a request being
   * paid to its send). The deletion row says so: `purging` is set before the
   * purge's first step, so a request freed after that is seen here.
   */
  private async closeIfAskerErased(
    requestId: string,
    chatId: string,
    askerWawuId: string,
  ): Promise<void> {
    const erased = await this.prisma.accountDeletion.findFirst({
      where: {
        wawuUserId: askerWawuId,
        status: { in: ['purging', 'purged'] },
      },
      select: { wawuUserId: true },
    });
    if (!erased) return;
    const { count } = await this.prisma.moneyRequest.updateMany({
      where: { id: requestId, status: 'pending', transferId: null },
      data: { status: 'cancelled', changedAt: new Date(), memo: null },
    });
    if (count === 1) {
      await this.live.publish({
        kind: 'money_request.updated',
        chatId,
        requestId,
      });
    }
  }

  /** Every 30 seconds: payments that were not confirmed when they were made. */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'money-request-sweep' })
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const due = await this.prisma.moneyRequest.findMany({
        where: { status: 'pending', transferId: { not: null } },
        orderBy: { updatedAt: 'asc' },
        take: SWEEP_PAGE,
        select: { id: true },
      });
      for (const { id } of due) await this.settleOne(id);
      return due.length;
    } finally {
      this.sweeping = false;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The request, if the caller is one of its two people and it is in that chat. */
  private async mine(
    me: string,
    chatId: string,
    requestId: string,
  ): Promise<MoneyRequestRow> {
    const row = await this.prisma.moneyRequest.findFirst({
      where: {
        id: requestId,
        conversationId: chatId,
        OR: [{ requesterWawuId: me }, { payerWawuId: me }],
      },
    });
    if (!row) throw new NotFoundException(REQUEST_NOT_FOUND_MESSAGE);
    return row;
  }

  private findByClientId(chatId: string, me: string, clientRequestId: string) {
    return this.prisma.moneyRequest.findUnique({
      where: {
        conversationId_requesterWawuId_clientRequestId: {
          conversationId: chatId,
          requesterWawuId: me,
          clientRequestId,
        },
      },
    });
  }

  /** The chat message that carries a request, as `me` sees it. */
  private async messageOf(
    me: string,
    request: MoneyRequestRow,
  ): Promise<ChatMessage> {
    const message = await this.prisma.chatMessage.findUniqueOrThrow({
      where: { id: request.messageId ?? '' },
    });
    return this.chats.viewMessage(me, message);
  }

  private notActionable(row: {
    status: string;
    transferId: string | null;
  }): ConflictException {
    if (row.status === 'pending' && row.transferId !== null) {
      return new ConflictException({
        message: REQUEST_BEING_PAID_MESSAGE,
        reason: { code: 'money_request_being_paid' },
      });
    }
    return new ConflictException({
      message: requestNotPendingMessage(row.status),
      reason: { code: 'money_request_not_pending', status: row.status },
    });
  }
}
