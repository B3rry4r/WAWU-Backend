import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { toWireDm, type DirectMessage, type DmOtherParty } from '../common/types';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import { NotificationService } from '../notification/notification.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { DmReplyWriter } from './dm-reply-writer';
import type { SendDmDto } from './dto/send-dm.dto';
import type { VerifyDmDto } from './dto/verify-dm.dto';
import type { RespondDmDto } from './dto/respond-dm.dto';

const ONE_HOUR_MS = 60 * 60 * 1000;
/** Fallback only, for a creator row written before dmResponseHours existed. */
const DEFAULT_RESPONSE_WINDOW_HOURS = 24;

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
  /**
   * Snapshotted CreatorState.dmResponseHours at send time, for the same
   * reason as the price: the payer is quoted a reply window at checkout, and
   * a creator widening their window afterwards must not retroactively extend
   * a deadline that someone has already paid against.
   */
  responseWindowHours: number;
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
  /**
   * Persisted, not in-memory — a process-local Map lost the record on any
   * deploy, crash or second replica between the checkout popup and its
   * callback, stranding a real charge with nothing to reconcile against.
   * Keyed by the messageId (threadId) the client verifies with; the txRef
   * is kept in context so verify can still bind the two.
   */
  private async recordPendingDm(
    messageId: string,
    attempt: PendingDmAttempt,
  ): Promise<void> {
    await this.prisma.pendingCharge.create({
      data: {
        txRef: messageId,
        kind: 'dm',
        wawuUserId: attempt.senderWawuId,
        expectedAmount: attempt.amount,
        context: {
          txRef: attempt.txRef,
          creatorWawuId: attempt.creatorWawuId,
          text: attempt.text,
          responseWindowHours: attempt.responseWindowHours,
        },
      },
    });
  }

  private async takePendingDm(
    messageId: string,
  ): Promise<PendingDmAttempt | null> {
    const row = await this.prisma.pendingCharge.findUnique({
      where: { txRef: messageId },
    });
    if (!row || row.kind !== 'dm') return null;
    const ctx = (row.context ?? {}) as {
      txRef?: string;
      creatorWawuId?: string;
      text?: string;
      responseWindowHours?: number;
    };
    return {
      txRef: ctx.txRef ?? '',
      creatorWawuId: ctx.creatorWawuId ?? '',
      senderWawuId: row.wawuUserId,
      text: ctx.text ?? '',
      amount: row.expectedAmount,
      // A charge opened before this field existed still has to settle.
      responseWindowHours:
        ctx.responseWindowHours ?? DEFAULT_RESPONSE_WINDOW_HOURS,
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
    private readonly notifications: NotificationService,
    private readonly blockedAccounts: BlockedAccountService,
    private readonly wawuId: WawuIdClient,
    private readonly replyWriter: DmReplyWriter,
  ) {}

  /**
   * Batch profile lookup for the "other party" in a page of DM threads —
   * same shape as CreatorDiscoveryService.list() and
   * ProfessionalService.list(): one WawuIdClient.lookupPublicIdentities call
   * for names/badge tiers plus one userProfile.findMany for handle/avatar,
   * merged by id. `inbox()`/`threads()` call this once per page (not once
   * per row), and `findOne()` calls it with a single id.
   */
  async lookupOtherParties(
    otherPartyIds: string[],
  ): Promise<Map<string, DmOtherParty>> {
    const unique = [...new Set(otherPartyIds)];
    const out = new Map<string, DmOtherParty>();
    if (unique.length === 0) return out;

    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));

    for (const id of unique) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        wawuId: id,
        name: fullName || profile?.handle || '',
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        // Both ticks, derived through the one function. An id with no profile
        // row on this service carries neither.
        verification: deriveVerificationState(profile ?? null),
      });
    }
    return out;
  }

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

    // THE blocking gate. Enforced here — at send-init, before the
    // Flutterwave charge is created — and deliberately not at
    // /send/verify: by verify time the fan has already been charged, and
    // refusing there would take their money for a message that is never
    // delivered. Symmetric: a creator who blocked this fan cannot be
    // messaged by them, and a fan who blocked this creator cannot pay them
    // either.
    await this.blockedAccounts.assertNotBlocked(
      senderWawuId,
      creatorWawuId,
      'You cannot send a paid direct message to this account.',
    );

    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { dmPrice: true, dmEnabled: true, dmResponseHours: true },
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
    const responseWindowHours =
      creatorState.dmResponseHours ?? DEFAULT_RESPONSE_WINDOW_HOURS;
    const threadId = randomUUID();
    const charge = this.flutterwave.initCharge({
      amount,
      purpose: 'dm',
      wawuUserId: senderWawuId,
    });

    await this.recordPendingDm(threadId, {
      txRef: charge.txRef,
      creatorWawuId,
      senderWawuId,
      text: dto.text,
      amount,
      responseWindowHours,
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
    const pending = await this.takePendingDm(messageId);
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
    const claim = await this.prisma.pendingCharge.deleteMany({
      where: { txRef: messageId },
    });

    if (!verified) {
      throw new BadRequestException('Payment verification failed');
    }

    if (claim.count === 0) {
      // The browser's /verify and the Flutterwave webhook can settle the same
      // charge concurrently; only the caller that removed the pending row may
      // create the DM. The other returns the DM that now exists rather than
      // colliding on its primary key.
      const settled = await this.prisma.directMessage.findUnique({
        where: { id: messageId },
      });
      if (settled) return toWireDm(settled);
      throw new NotFoundException(
        'No matching DM send attempt found for this reference',
      );
    }

    const sentAt = new Date();
    const responseWindowHours =
      pending.responseWindowHours ?? DEFAULT_RESPONSE_WINDOW_HOURS;
    const deadlineAt = new Date(
      sentAt.getTime() + responseWindowHours * ONE_HOUR_MS,
    );

    const created = await this.prisma.directMessage.create({
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
        // Captured HERE or never: Flutterwave's refund endpoint is keyed by
        // this id, and after this request nothing else knows it. Discarding
        // it is the concrete reason no expired DM could be refunded.
        flutterwaveTxId: result.transactionId,
        responseWindowHours,
      },
    });

    // "Someone paid to message you" — to the CREATOR, and only on the branch
    // that actually created the DM. The early-return above (webhook and
    // browser settling the same charge) returns an already-created DM and
    // must not announce it a second time. A failed verification threw before
    // this point, so an unpaid DM never produces a notification.
    await this.notifications.emit({
      kind: 'dm_received',
      userWawuId: created.creatorWawuId,
      amount: created.amount,
    });

    return toWireDm(created);
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
    // The write, the first-reply flip and the reply bubble are one
    // transaction in DmReplyWriter, shared with the INBOX-08 reply route.
    const { message } = await this.replyWriter.post(
      creatorWawuId,
      messageId,
      dto.text,
      'first',
    );
    return toWireDm(message);
  }

  /**
   * GET /dm/inbox (roles: creator) — the creator's own incoming DMs. The
   * OTHER party on this view is always the sender (the fan who paid), so the
   * batch lookup is keyed on `senderWawuId` across the whole page — one
   * lookup call, not one per row.
   */
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
    const otherParties = await this.lookupOtherParties(
      items.map((i) => i.senderWawuId),
    );
    return {
      items: items.map((i) =>
        toWireDm(i, otherParties.get(i.senderWawuId) ?? null),
      ),
      currentPage: page,
      perPage,
      total,
    };
  }

  /**
   * GET /dm/threads (roles: any) — the caller's own sent DMs. The OTHER
   * party on this view is always the creator being messaged, so the batch
   * lookup is keyed on `creatorWawuId` across the whole page.
   */
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
    const otherParties = await this.lookupOtherParties(
      items.map((i) => i.creatorWawuId),
    );
    return {
      items: items.map((i) =>
        toWireDm(i, otherParties.get(i.creatorWawuId) ?? null),
      ),
      currentPage: page,
      perPage,
      total,
    };
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
    // Whichever one the caller isn't — the fan sees the creator, the
    // creator sees the fan, same rule as inbox()/threads() above.
    const otherPartyId =
      dm.senderWawuId === callerWawuId ? dm.creatorWawuId : dm.senderWawuId;
    const otherParties = await this.lookupOtherParties([otherPartyId]);
    return toWireDm(dm, otherParties.get(otherPartyId) ?? null);
  }
}
