import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { DirectMessage } from '../common/types';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { SendDmDto } from './dto/send-dm.dto';
import type { VerifyDmDto } from './dto/verify-dm.dto';
import type { RespondDmDto } from './dto/respond-dm.dto';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DmSendInitResponse {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
  threadId: string;
}

interface PendingDmAttempt {
  txRef: string;
  creatorWawuId: string;
  senderWawuId: string;
  text: string;
  /** Snapshotted CreatorState.dmPrice at send time — registry note. */
  amount: number;
}

/**
 * DirectMessage resource — registry.json "DirectMessage". Paid creator DMs
 * with a 24h response deadline.
 *
 * JUDGMENT — `pendingAttempts` in-memory map: identical rationale to
 * src/creator-subscription/creator-subscription.service.ts's own
 * `pendingAttempts` map (see that file's doc comment for the full
 * argument). Here it's needed because POST /dm/:creatorWawuId/send only
 * inits the Flutterwave charge — it must NOT create the real DirectMessage
 * row yet (the row only becomes real once the charge is server-verified;
 * creating it eagerly would let an abandoned/failed charge leave a phantom
 * "awaiting_response" DM in a creator's inbox). Keyed by the `threadId`
 * (== the eventual DirectMessage.id, minted at send-init time) rather than
 * by `txRef` directly, because the frozen contract puts the id in the
 * verify endpoint's own URL (`POST /dm/:messageId/send/verify`), not in its
 * body — the body only carries Flutterwave's own `transaction_id`/`tx_ref`
 * echo. `txRef` is still cross-checked against the body's `tx_ref` at
 * verify time as a defense against a caller guessing another pending
 * `messageId` and replaying an unrelated `tx_ref` against it. Process-
 * lifetime bridge only, not durable storage — a server restart between
 * send and verify loses the pending attempt (404 on verify, sender must
 * restart the send flow). Acceptable for this build per the same deferred-
 * webhook-infra rationale as CreatorSubscription's.
 */
@Injectable()
export class DirectMessageService {
  private readonly pendingAttempts = new Map<string, PendingDmAttempt>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  /**
   * POST /dm/:creatorWawuId/send (roles: any). Inits the Flutterwave charge
   * only — does not create the DirectMessage row (see class doc comment).
   *
   * JUDGMENT — 403 vs 400 when the target hasn't enabled paid DMs: this
   * mirrors src/content-piece/content-piece.service.ts's precedent for "a
   * gate/precondition on the OTHER party's state isn't satisfied" (that
   * resource's upload-gate throws ForbiddenException, not
   * BadRequestException, when CreatorState.subscriptionPaid is false) —
   * the request is well-formed, but the action is not permitted given the
   * target's current state. 404 is reserved for "this creatorWawuId
   * doesn't exist at all".
   *
   * JUDGMENT — checks BOTH `dmEnabled` and `dmPrice != null`, though the
   * task brief calls out `dmPrice` alone: the frozen schema keeps these as
   * two independent fields (`dmPrice Int?`, `dmEnabled Boolean
   * @default(false)`), and prisma/seed.ts always sets them together. A
   * creator who has disabled paid DMs but still has a stale `dmPrice` value
   * on the row should not be DM-able — checking only `dmPrice` would miss
   * that case, so both are required to be "on".
   *
   * JUDGMENT — rejects a creator DMing themselves (400), mirroring
   * src/purchase/purchase.service.ts's `createTip` self-tip guard; not
   * explicitly in the frozen contract but the same reasoning applies.
   */
  async sendInit(
    senderWawuId: string,
    creatorWawuId: string,
    dto: SendDmDto,
  ): Promise<DmSendInitResponse> {
    if (creatorWawuId === senderWawuId) {
      throw new BadRequestException('Cannot send a paid DM to yourself');
    }

    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { dmPrice: true, dmEnabled: true },
    });
    if (!creatorState) {
      throw new NotFoundException('Creator not found');
    }
    if (!creatorState.dmEnabled || creatorState.dmPrice == null) {
      throw new ForbiddenException(
        'This creator has not enabled paid direct messages.',
      );
    }

    const amount = creatorState.dmPrice;
    const threadId = randomUUID();
    const charge = this.flutterwave.initCharge({
      amount,
      purpose: 'dm',
      wawuUserId: senderWawuId,
    });

    this.pendingAttempts.set(threadId, {
      txRef: charge.txRef,
      creatorWawuId,
      senderWawuId,
      text: dto.text,
      amount,
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
      threadId,
    };
  }

  /**
   * POST /dm/:messageId/send/verify (roles: any). Server-verifies the
   * charge, then creates the real DirectMessage row. `amount` is the
   * dmPrice snapshotted at send time (registry note); `deadlineAt` =
   * `sentAt` + 24h (registry note: "single locked deadline" — never
   * recomputed or extended after creation).
   */
  async sendVerify(
    senderWawuId: string,
    messageId: string,
    dto: VerifyDmDto,
  ): Promise<DirectMessage> {
    const pending = this.pendingAttempts.get(messageId);
    if (
      !pending ||
      pending.senderWawuId !== senderWawuId ||
      pending.txRef !== dto.tx_ref
    ) {
      throw new NotFoundException(
        'No matching DM send attempt found for this reference',
      );
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const verified =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === pending.txRef &&
      result.amount >= pending.amount;

    // Consumed on resolution either way — a second verify against the same
    // messageId has nothing left to match (mirrors CreatorSubscription's
    // documented precedent).
    this.pendingAttempts.delete(messageId);

    if (!verified) {
      throw new BadRequestException('Payment verification failed');
    }

    const sentAt = new Date();
    const deadlineAt = new Date(sentAt.getTime() + ONE_DAY_MS);

    return this.prisma.directMessage.create({
      data: {
        id: messageId,
        creatorWawuId: pending.creatorWawuId,
        senderWawuId: pending.senderWawuId,
        text: pending.text,
        amount: pending.amount,
        status: 'awaiting_response',
        sentAt,
        deadlineAt,
        respondedAt: null,
        responseText: null,
        flutterwaveTxRef: pending.txRef,
      },
    });
  }

  /**
   * POST /dm/:messageId/respond (roles: creator, and must be the creator
   * this DM was sent TO — 403 otherwise, per the task brief). Sets
   * status=responded. This status flip IS the payout-release signal
   * CreatorEarnings' aggregate query reads directly off DirectMessage.status
   * (registry note / task brief — no separate ledger write here).
   *
   * JUDGMENT — defensive real-time deadline check: the sweep-cron that is
   * supposed to flip an expired `awaiting_response` DM to `refunded` is
   * deferred (declared/scheduled-jobs.json, not yet built). Per the task
   * brief, this endpoint does its own real-time check in the meantime — if
   * `deadlineAt < now()` and status is still `awaiting_response`, the
   * response is rejected as too late (409). It deliberately does NOT flip
   * status to `refunded` itself here — that write belongs to the future
   * cron (and a bare respond attempt has no refund/payment-reversal side
   * effect to perform), so the row is left untouched and only this specific
   * request is rejected.
   */
  async respond(
    creatorWawuId: string,
    messageId: string,
    dto: RespondDmDto,
  ): Promise<DirectMessage> {
    const dm = await this.prisma.directMessage.findUnique({
      where: { id: messageId },
    });
    if (!dm) {
      throw new NotFoundException('Direct message not found');
    }
    if (dm.creatorWawuId !== creatorWawuId) {
      throw new ForbiddenException(
        'You are not the creator this direct message was sent to.',
      );
    }
    if (dm.status !== 'awaiting_response') {
      throw new ConflictException(
        `This direct message is already ${dm.status} and cannot be responded to.`,
      );
    }
    if (dm.deadlineAt.getTime() < Date.now()) {
      throw new ConflictException(
        'The 24-hour response window for this direct message has passed.',
      );
    }

    return this.prisma.directMessage.update({
      where: { id: messageId },
      data: {
        status: 'responded',
        respondedAt: new Date(),
        responseText: dto.text,
      },
    });
  }

  /** GET /dm/inbox (roles: creator) — the creator's own incoming DMs. */
  async inbox(
    creatorWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<DirectMessage>> {
    const [items, total] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: { creatorWawuId },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.directMessage.count({ where: { creatorWawuId } }),
    ]);
    return { items, currentPage: page, perPage, total };
  }

  /** GET /dm/threads (roles: any) — the caller's own sent DMs. */
  async threads(
    senderWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<DirectMessage>> {
    const [items, total] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: { senderWawuId },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.directMessage.count({ where: { senderWawuId } }),
    ]);
    return { items, currentPage: page, perPage, total };
  }

  /**
   * GET /dm/:messageId (roles: any).
   *
   * JUDGMENT — 404 (not 403) when the caller is neither the sender nor the
   * creator: mirrors src/content-piece/content-piece.service.ts's own
   * precedent for hiding a private resource from an unauthorized caller
   * (`getById` throws the identical NotFoundException for "doesn't exist"
   * and "exists but you can't see it", rather than a distinguishing 403,
   * so a prying caller cannot use the response code to enumerate which
   * message IDs are real). src/dm-report's single endpoint has no read
   * path to compare against; content-piece is the closer, directly
   * on-point precedent in this codebase.
   */
  async findOne(
    callerWawuId: string,
    messageId: string,
  ): Promise<DirectMessage> {
    const dm = await this.prisma.directMessage.findUnique({
      where: { id: messageId },
    });
    if (
      !dm ||
      (dm.senderWawuId !== callerWawuId && dm.creatorWawuId !== callerWawuId)
    ) {
      throw new NotFoundException('Direct message not found');
    }
    return dm;
  }
}
